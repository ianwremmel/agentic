import type {Database} from '../db/database.mts';
import {assertInstant} from '../db/time.mts';
import {DataError, ensure} from '../errors/index.mts';
import {findNode} from './materialize.mts';

/* eslint-disable @typescript-eslint/require-await --
 * Async facade over synchronous `node:sqlite`; see `../db/database.mts`. */

/**
 * Where a node's worker can be reached. The orchestrate session records the
 * agent ref it got back from a launch; the tick stamps it onto events for the
 * node so the session can relay instead of cold-starting a resume pass.
 *
 * A row lives from launch to outcome — not to yield. A yielded worker has
 * returned but is resumable with its context intact, and waking it with the
 * event that ends its wait is the whole point of routing. Death is covered
 * twice over: the row cascades with its session, and a stale ref relayed to a
 * gone agent is a no-op the resume pass then catches.
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
   */
  async remove(node: string, session: string): Promise<boolean> {
    return this.#db.transaction(() => {
      const removed = this.#db.run(
        `DELETE FROM worker
         WHERE node_id = (SELECT id FROM node WHERE external_id = ?)
           AND session_id = ?`,
        [node, session]
      );
      if (removed === 0) return false;
      this.#db.run(
        `DELETE FROM claim
         WHERE node_id = (SELECT id FROM node WHERE external_id = ?)
           AND session_id = ?`,
        [node, session]
      );
      return true;
    });
  }
}

/* eslint-enable @typescript-eslint/require-await */
