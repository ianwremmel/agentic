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
    await this.#db.transaction(() => {
      const node = findNode(this.#db, input.node);
      ensure(
        node !== null,
        () =>
          new DataError(`no node "${input.node}" to register a worker on`, {
            hint: 'a worker is recorded for a node the graph already holds.',
          })
      );
      this.#db.run(
        `INSERT INTO worker (node_id, session_id, agent_ref, launched_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(node_id) DO UPDATE SET
           session_id = excluded.session_id,
           agent_ref = excluded.agent_ref,
           launched_at = excluded.launched_at`,
        [node.id, input.session, input.agentRef, input.at]
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

  async remove(node: string): Promise<boolean> {
    return (
      this.#db.run(
        `DELETE FROM worker
         WHERE node_id = (SELECT id FROM node WHERE external_id = ?)`,
        [node]
      ) > 0
    );
  }
}

/* eslint-enable @typescript-eslint/require-await */
