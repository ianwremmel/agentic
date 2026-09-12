import type {Database} from '../db/database.mts';
import {assertInstant} from '../db/time.mts';
import {DataError, ensure} from '../errors/index.mts';
import {findNode} from './materialize.mts';

/**
 * What a handover did, and when it did nothing, why:
 *
 * - `not-this-turn` — the address is being kept, because the turn reported is
 *   not the one holding the node: a later relay re-claimed, the worker yielded
 *   and holds no claim at all, or another session owns it now.
 * - `no-turn` — nothing was reported, so there is nothing to match. The one
 *   caller mistake this command can name.
 * - `no-address` — this session has no worker row on the node. Expected after
 *   a clean report, which takes the row with it.
 * - `not-yours` — another session's address, which is not this caller's to
 *   revoke.
 */
export type RemoveOutcome =
  'removed' | 'not-this-turn' | 'no-turn' | 'no-address' | 'not-yours';

/* eslint-disable @typescript-eslint/require-await --
 * Async facade over synchronous `node:sqlite`; see `../db/database.mts`. */

/**
 * Did the turn being reported on end without giving anything back? A relay
 * that takes a node's claim dates it, so `claimed_at` identifies that turn: a
 * claim still standing at the reported instant, whose agent has come back, is
 * a turn that neither yielded nor reported, and nothing is going to move it.
 *
 * Any other claimed_at is a different turn — a later relay re-took the claim
 * and is working — and no claim at all means the worker yielded, which is the
 * warm path waiting for the server, not a stall.
 *
 * The comparison is on the instant, not the spelling: the caller is an agent
 * copying a token out of an event, and `2026-08-07T12:00:00Z` is the same turn
 * as `2026-08-07T12:00:00.000Z`. A refusal has to mean a different turn, never
 * a differently-formatted one, or the item pins on a formatting difference no
 * one can see.
 */
function stalled(
  row: Record<string, unknown>,
  session: string,
  turn: string
): boolean {
  if (row.claim_session !== session) return false;
  return (
    typeof row.claimed_at === 'string' &&
    Date.parse(row.claimed_at) === Date.parse(turn)
  );
}

/**
 * Where a node's worker can be reached. The orchestrate session records the
 * agent ref it got back from a launch; the tick stamps it onto events for the
 * node so the session can relay instead of cold-starting a resume pass.
 *
 * A row lives from launch to outcome — not to yield. A yielded worker has
 * returned but is resumable with its context intact, and waking it with the
 * event that ends its wait is the whole point of routing. Death is covered
 * twice over: the row cascades with its session, and while the session lives
 * `remove` is the handover — the session calls it every time an agent it
 * relayed to comes back, and it drops the row only for the turn that return
 * reports on.
 */
export class WorkerStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  async set(input: {
    node: string;
    session: string;
    agentRef: string;
    at: string;
  }): Promise<void> {
    assertInstant(input.at, 'at');
    const agentRef = input.agentRef.trim();
    ensure(
      agentRef !== '',
      () =>
        new DataError('an empty agent ref is not an address', {
          hint: 'pass the ref the launch returned.',
        })
    );
    await this.#db.transaction(() => {
      const node = findNode(this.#db, input.node);
      ensure(
        node !== null,
        () =>
          new DataError(`no node "${input.node}" to register a worker on`, {
            hint: 'a worker is recorded for a node the graph already holds.',
          })
      );
      // The address belongs to a dispatched worker, so the recorder must
      // still hold the claim its launch took. This is also what closes the
      // fast-worker race: an outcome recorded before the address deletes the
      // claim, and the late `worker set` is then refused instead of
      // recreating a row for an agent that already finished.
      const claim = this.#db.get(
        'SELECT session_id FROM claim WHERE node_id = ?',
        [node.id]
      );
      ensure(
        claim?.session_id === input.session,
        () =>
          new DataError(
            `this session holds no claim on "${input.node}", so there is no dispatched worker to address`,
            {
              hint: 'record the address right after the launch, before anything else; if the worker already reported, there is nothing to route to.',
            }
          )
      );
      this.#db.run(
        `INSERT INTO worker (node_id, session_id, agent_ref, launched_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(node_id) DO UPDATE SET
           session_id = excluded.session_id,
           agent_ref = excluded.agent_ref,
           launched_at = excluded.launched_at`,
        [node.id, input.session, agentRef, input.at]
      );
    });
  }

  /** The agent ref holding a node, for this session only: another session's
   * worker is not addressable from here. */
  async refFor(node: string, session: string): Promise<string | null> {
    const row = this.#db.get(
      `SELECT w.agent_ref FROM worker w
       JOIN node n ON n.id = w.node_id
       WHERE n.external_id = ? AND w.session_id = ?`,
      [node, session]
    );
    return typeof row?.agent_ref === 'string' ? row.agent_ref : null;
  }

  /**
   * Hand a node from warm relay to cold recovery: drop the caller's own
   * address and release its claim in one transaction. While either existed
   * the item could not queue; with both gone the scheduler re-serves it as a
   * `resume` pass. Scoped to the owning session — another session's address
   * is not this caller's to revoke.
   *
   * `turn` is what makes this safe to run every time a relayed agent comes
   * back, which is how a dead worker gets noticed at all: a worker has no
   * heartbeat, so its liveness in this database is its launching session's,
   * and that session outlives it. The relay hands out the instant of the claim
   * it took, the session hands that instant back, and only the turn it names
   * is removable. A return that arrives after a later relay has already
   * re-claimed names a turn that is over; without that check it would delete
   * the running turn's grant and let cold recovery race a live agent.
   *
   * A yielded worker is out of scope by construction — it gave the claim back,
   * so no turn matches, and its address survives for the relay it is waiting
   * on. So is a worker whose turn no relay ever dated: nothing names it, and
   * only `force` can hand it over.
   *
   * `force` drops this session's address whatever the state, and releases the
   * claim only if this session holds it. For an operator retiring a warm agent
   * by hand; a session reporting an agent's return always has the turn and
   * never needs this.
   */
  async remove(
    node: string,
    session: string,
    opts: {turn?: string | undefined; force?: boolean | undefined} = {}
  ): Promise<RemoveOutcome> {
    if (opts.turn !== undefined) assertInstant(opts.turn, 'turn');
    return this.#db.transaction(() => {
      const row = this.#db.get(
        `SELECT w.session_id AS worker_session,
                c.session_id AS claim_session, c.claimed_at AS claimed_at
         FROM worker w
         JOIN node n ON n.id = w.node_id
         LEFT JOIN claim c ON c.node_id = w.node_id
         WHERE n.external_id = ?`,
        [node]
      );
      if (row === undefined) return 'no-address';
      if (row.worker_session !== session) return 'not-yours';
      if (opts.force !== true) {
        if (opts.turn === undefined) return 'no-turn';
        if (!stalled(row, session, opts.turn)) return 'not-this-turn';
      }
      this.#db.run(
        `DELETE FROM worker
         WHERE node_id = (SELECT id FROM node WHERE external_id = ?)
           AND session_id = ?`,
        [node, session]
      );
      this.#db.run(
        `DELETE FROM claim
         WHERE node_id = (SELECT id FROM node WHERE external_id = ?)
           AND session_id = ?`,
        [node, session]
      );
      return 'removed';
    });
  }
}

/* eslint-enable @typescript-eslint/require-await */
