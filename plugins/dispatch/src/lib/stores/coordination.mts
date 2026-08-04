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
  outcome: 'claimed' | 'refreshed' | 'held' | 'unknown-node';
  /** The session that holds it when the outcome is `held`. */
  heldBy?: string;
}

/**
 * The runtime coordination a live unit holds and reports: claims (locks), slots
 * (compute capacity), and outcomes (final reports). Grouped because they are
 * transactionally linked — recording an outcome releases the reporter's claim
 * and slot in the same write.
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
   * Acquire a compute slot, bounded globally by `max`. Idempotent per
   * `(session, actor)` via the UNIQUE constraint: a re-acquire refreshes.
   */
  async acquireSlot(input: {
    session: string;
    actor: string;
    max: number;
    acquiredAt: string;
  }): Promise<'acquired' | 'refreshed' | 'full'> {
    assertInstant(input.acquiredAt, 'acquiredAt');
    return this.#db.transaction(() => {
      const held = this.#db.get(
        'SELECT 1 FROM slot WHERE session_id = ? AND actor = ?',
        [input.session, input.actor]
      );
      if (held !== undefined) {
        this.#db.run(
          'UPDATE slot SET acquired_at = ? WHERE session_id = ? AND actor = ?',
          [input.acquiredAt, input.session, input.actor]
        );
        return 'refreshed';
      }
      const count = Number(
        this.#db.get('SELECT COUNT(*) AS n FROM slot')?.n ?? 0
      );
      if (count >= input.max) return 'full';
      this.#db.run(
        'INSERT INTO slot (session_id, actor, acquired_at) VALUES (?, ?, ?)',
        [input.session, input.actor, input.acquiredAt]
      );
      return 'acquired';
    });
  }

  async releaseSlot(session: string, actor: string): Promise<boolean> {
    return (
      this.#db.run('DELETE FROM slot WHERE session_id = ? AND actor = ?', [
        session,
        actor,
      ]) > 0
    );
  }

  /** The session whose slot an actor holds, or null when none does. */
  async slotHolder(actor: string): Promise<string | null> {
    const row = this.#db.get('SELECT session_id FROM slot WHERE actor = ?', [
      actor,
    ]);
    return row === undefined ? null : String(row.session_id);
  }

  async slotCount(): Promise<number> {
    return Number(this.#db.get('SELECT COUNT(*) AS n FROM slot')?.n ?? 0);
  }

  /**
   * Units of work currently in flight: every held slot plus every node with a
   * live claim, counting a unit that holds both exactly once (a worker's slot
   * actor is the external id of the node it claimed). A claim is an obligation
   * to run an agent whether or not that agent has reached its compute phase,
   * so this — not the slot count alone — is what admissions budget against.
   */
  async inFlightCount(input: {
    now: string;
    staleAfterSeconds: number;
  }): Promise<number> {
    assertInstant(input.now, 'now');
    const row = this.#db.get(
      `SELECT
         (SELECT COUNT(*) FROM slot)
         + (SELECT COUNT(*)
            FROM claim c
            JOIN session s ON s.id = c.session_id
            JOIN node n ON n.id = c.node_id
            WHERE unixepoch(?) - unixepoch(s.heartbeat_at) <= ?
              AND n.external_id NOT IN (SELECT actor FROM slot)) AS n`,
      [input.now, input.staleAfterSeconds]
    );
    return Number(row?.n ?? 0);
  }

  /**
   * Record a unit's final report on a node, releasing its claim and slot in the
   * same transaction — the artifact proves its writer exited. One row per node;
   * a later pass's report replaces it.
   */
  async recordOutcome(
    report: {
      node: string;
      outcome: OutcomeKind;
      retryable: boolean | null;
      detail: string | null;
      recordedAt: string;
    },
    holder: {session: string; actor?: string}
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
      if (holder.actor !== undefined) {
        this.#db.run('DELETE FROM slot WHERE session_id = ? AND actor = ?', [
          holder.session,
          holder.actor,
        ]);
      }
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
