import type {Database} from '../db/database.mts';
import {DataError, ensure} from '../errors/index.mts';
import type {Edge} from '../model/types.mts';
import {nodeRef} from './materialize.mts';

/* eslint-disable @typescript-eslint/require-await --
 * Async facade over synchronous `node:sqlite`; see `../db/database.mts`. */

/** The blocking DAG. `blocker` blocks `blocked`; any kind may block any other. */
export class EdgeStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  async addEdge(blocker: string, blocked: string): Promise<boolean> {
    return this.#db.transaction(() => {
      const added = this.#insert(blocker, blocked);
      if (added) this.#rejectIfCycle(blocked);
      return added;
    });
  }

  async removeEdge(blocker: string, blocked: string): Promise<boolean> {
    return (
      this.#db.run(
        `DELETE FROM edge
         WHERE blocker = (SELECT id FROM node WHERE external_id = ?)
           AND blocked = (SELECT id FROM node WHERE external_id = ?)`,
        [blocker, blocked]
      ) > 0
    );
  }

  /**
   * Replace every edge in one direction of a node with the given set — lets a
   * re-fetch declare "these are now exactly my blockers/blocks" atomically.
   */
  async setEdges(
    node: string,
    direction: 'blockers' | 'blocks',
    others: readonly string[]
  ): Promise<void> {
    await this.#db.transaction(() => {
      const nodeId = nodeRef(this.#db, node);
      const column = direction === 'blockers' ? 'blocked' : 'blocker';
      this.#db.run(`DELETE FROM edge WHERE ${column} = ?`, [nodeId]);
      for (const other of others) {
        if (direction === 'blockers') this.#insert(other, node);
        else this.#insert(node, other);
      }
      this.#rejectIfCycle(node);
    });
  }

  async edges(): Promise<Edge[]> {
    return this.#db
      .all(
        `SELECT bn.external_id AS blocker, dn.external_id AS blocked
         FROM edge e
         JOIN node bn ON bn.id = e.blocker
         JOIN node dn ON dn.id = e.blocked`
      )
      .map((row) => ({
        blocker: String(row.blocker),
        blocked: String(row.blocked),
      }));
  }

  #insert(blocker: string, blocked: string): boolean {
    ensure(
      blocker !== blocked,
      () =>
        new DataError(`a node cannot block itself (${blocker})`, {
          hint: 'a self-edge is an illegal one-node cycle.',
        })
    );
    const blockerId = nodeRef(this.#db, blocker);
    const blockedId = nodeRef(this.#db, blocked);
    return (
      this.#db.run(
        'INSERT INTO edge (blocker, blocked) VALUES (?, ?) ON CONFLICT DO NOTHING',
        [blockerId, blockedId]
      ) > 0
    );
  }

  /**
   * Throw (rolling back the transaction) if `node` now sits on a cycle. A cycle
   * can only have appeared via an edge just written through `node`, so checking
   * reachability from it alone suffices. Walked by a recursive CTE.
   */
  #rejectIfCycle(externalId: string): void {
    const onCycle = this.#db.get(
      `WITH RECURSIVE reach(id) AS (
         SELECT blocked FROM edge
         WHERE blocker = (SELECT id FROM node WHERE external_id = ?)
         UNION
         SELECT e.blocked FROM edge e JOIN reach r ON e.blocker = r.id
       )
       SELECT 1 FROM reach
       WHERE id = (SELECT id FROM node WHERE external_id = ?) LIMIT 1`,
      [externalId, externalId]
    );
    ensure(
      onCycle === undefined,
      () =>
        new DataError(
          `that edge would create a dependency cycle through ${externalId}`,
          {
            hint: 'remove the opposing edge first, or fix the dependency direction.',
          }
        )
    );
  }
}

/* eslint-enable @typescript-eslint/require-await */
