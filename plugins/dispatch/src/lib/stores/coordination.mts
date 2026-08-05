import type {Database} from '../db/database.mts';
import {assertInstant} from '../db/time.mts';
import {DataError, ensure} from '../errors/index.mts';
import {isOutcome, OUTCOMES} from '../model/status.mts';
import type {OutcomeKind} from '../model/status.mts';
import type {Outcome} from '../model/types.mts';
import {findNode} from './materialize.mts';

/* eslint-disable @typescript-eslint/require-await --
 * Async facade over synchronous `node:sqlite`; see `../db/database.mts`. */

export interface ClaimResult {
  outcome: 'claimed' | 'refreshed' | 'held' | 'full' | 'unknown-node';
  /** The session that holds it when the outcome is `held`. */
  heldBy?: string;
}

/**
 * The runtime coordination a live unit holds and reports: claims and outcomes
 * (final reports). Grouped because they are transactionally linked — recording
 * an outcome releases the reporter's claim in the same write.
 *
 * The claim is also the compute grant: a worker is launched by the work order
 * that claims its node, and the claim is what the admission budget counts. That
 * makes the claim the machine-wide compute bound, so `claim` enforces the cap
 * inside its own transaction rather than trusting a caller's earlier count —
 * two servers scheduling at once both read the same free capacity, and only the
 * transaction can decide which of them gets it.
 */
export class CoordinationStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  async claim(input: {
    node: string;
    session: string;
    actor?: string;
    worktree?: string;
    branch?: string;
    claimedAt: string;
    /**
     * Bound on live claims across every session sharing this database — the
     * host's compute, not one session's share of it. A fresh claim past `max` is refused
     * as `full`; refreshing a claim this session already holds never is, so a
     * cap lowered under running work does not strand it. Omit to claim
     * unbounded. Both fields travel together because a live-claim count is
     * meaningless without the staleness window that defines "live".
     */
    capacity?: {max: number; staleAfterSeconds: number} | undefined;
  }): Promise<ClaimResult> {
    assertInstant(input.claimedAt, 'claimedAt');
    return this.#db.transaction(() => {
      const node = findNode(this.#db, input.node);
      if (node === null) return {outcome: 'unknown-node'};
      const existing = this.#db.get(
        'SELECT session_id FROM claim WHERE node_id = ?',
        [node.id]
      );
      if (existing !== undefined && existing.session_id !== input.session) {
        return {outcome: 'held', heldBy: String(existing.session_id)};
      }
      if (existing === undefined && input.capacity !== undefined) {
        const live = Number(
          this.#db.get(
            `SELECT COUNT(*) AS n
             FROM claim c
             JOIN session s ON s.id = c.session_id
             WHERE unixepoch(?) - unixepoch(s.heartbeat_at) <= ?`,
            [input.claimedAt, input.capacity.staleAfterSeconds]
          )?.n ?? 0
        );
        if (live >= input.capacity.max) return {outcome: 'full'};
      }
      this.#db.run(
        `INSERT INTO claim (node_id, session_id, actor, worktree, branch, claimed_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(node_id) DO UPDATE SET
           session_id = excluded.session_id, actor = excluded.actor,
           worktree = excluded.worktree, branch = excluded.branch,
           claimed_at = excluded.claimed_at`,
        [
          node.id,
          input.session,
          input.actor ?? null,
          input.worktree ?? null,
          input.branch ?? null,
          input.claimedAt,
        ]
      );
      return {outcome: existing === undefined ? 'claimed' : 'refreshed'};
    });
  }

  async release(
    node: string,
    session: string
  ): Promise<'released' | 'absent' | 'not-yours'> {
    return this.#db.transaction(() => {
      const row = this.#db.get(
        `SELECT session_id FROM claim
         WHERE node_id = (SELECT id FROM node WHERE external_id = ?)`,
        [node]
      );
      if (row === undefined) return 'absent';
      if (row.session_id !== session) return 'not-yours';
      this.#db.run(
        'DELETE FROM claim WHERE node_id = (SELECT id FROM node WHERE external_id = ?)',
        [node]
      );
      return 'released';
    });
  }

  /** Drop a recorded outcome, so the queue re-serves the node as fresh work. */
  async removeOutcome(node: string): Promise<boolean> {
    const found = findNode(this.#db, node);
    if (found === null) return false;
    return (
      this.#db.run('DELETE FROM outcome WHERE node_id = ?', [found.id]) > 0
    );
  }

  /* eslint-disable @typescript-eslint/no-base-to-string --
   * SQLite hands back `unknown`; `String()` converts a primitive rather than
   * asserting a type the row has not been checked for. */
  async claims(): Promise<
    {node: string; session: string; actor: string | null}[]
  > {
    return this.#db
      .all(
        `SELECT n.external_id AS node, c.session_id AS session, c.actor
         FROM claim c JOIN node n ON n.id = c.node_id`
      )
      .map((row) => ({
        node: String(row.node),
        session: String(row.session),
        actor: row.actor === null ? null : String(row.actor),
      }));
  }
  /* eslint-enable @typescript-eslint/no-base-to-string */

  /**
   * Units of work currently in flight: every node held by a live claim. A
   * claim is an obligation to run an agent — created when the scheduler emits
   * the work order, dropped when the agent reports an outcome or hands its
   * wait back to the server — so counting live claims is what bounds how many
   * agents run at once.
   */
  async inFlightCount(input: {
    now: string;
    staleAfterSeconds: number;
  }): Promise<number> {
    assertInstant(input.now, 'now');
    const row = this.#db.get(
      `SELECT COUNT(*) AS n
       FROM claim c
       JOIN session s ON s.id = c.session_id
       WHERE unixepoch(?) - unixepoch(s.heartbeat_at) <= ?`,
      [input.now, input.staleAfterSeconds]
    );
    return Number(row?.n ?? 0);
  }

  /**
   * Record a unit's final report on a node, releasing its claim in the same
   * transaction — the artifact proves its writer exited. One row per node; a
   * later pass's report replaces it.
   */
  async recordOutcome(
    report: {
      node: string;
      outcome: OutcomeKind;
      retryable: boolean | null;
      detail: string | null;
      recordedAt: string;
    },
    holder: {session: string}
  ): Promise<void> {
    ensure(
      isOutcome(report.outcome),
      () =>
        new DataError(`"${report.outcome}" is not an outcome`, {
          hint: `use one of: ${OUTCOMES.join(', ')}.`,
        })
    );
    ensure(
      report.retryable === null || report.outcome === 'failed',
      () =>
        new DataError('retryable is meaningful only with outcome "failed"', {
          hint: 'drop retryable, or report the failure as outcome "failed".',
        })
    );
    assertInstant(report.recordedAt, 'recordedAt');
    await this.#db.transaction(() => {
      const node = findNode(this.#db, report.node);
      ensure(
        node !== null,
        () =>
          new DataError(`no node "${report.node}" to record an outcome on`, {
            hint: 'an outcome is recorded on a node the graph already holds.',
          })
      );
      this.#db.run(
        `INSERT INTO outcome (node_id, outcome, retryable, detail, recorded_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(node_id) DO UPDATE SET
           outcome = excluded.outcome, retryable = excluded.retryable,
           detail = excluded.detail, recorded_at = excluded.recorded_at`,
        [
          node.id,
          report.outcome,
          report.retryable === null ? null : report.retryable ? 1 : 0,
          report.detail,
          report.recordedAt,
        ]
      );
      this.#db.run('DELETE FROM claim WHERE node_id = ? AND session_id = ?', [
        node.id,
        holder.session,
      ]);
    });
  }

  /* eslint-disable @typescript-eslint/no-base-to-string --
   * SQLite hands back `unknown`; `String()` converts a primitive rather than
   * asserting a type the row has not been checked for. */
  async getOutcome(node: string): Promise<Outcome | null> {
    const row = this.#db.get(
      `SELECT n.external_id AS node, o.outcome, o.retryable, o.detail, o.recorded_at
       FROM outcome o JOIN node n ON n.id = o.node_id
       WHERE n.external_id = ?`,
      [node]
    );
    if (row === undefined) return null;
    return {
      node: String(row.node),
      outcome: row.outcome as OutcomeKind,
      retryable: row.retryable === null ? null : row.retryable === 1,
      detail: row.detail === null ? null : String(row.detail),
      recordedAt: String(row.recorded_at),
    };
  }
  /* eslint-enable @typescript-eslint/no-base-to-string */
}

/* eslint-enable @typescript-eslint/require-await */
