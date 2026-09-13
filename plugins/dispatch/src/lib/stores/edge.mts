import type {Database} from '../db/database.mts';
import {DataError, ensure, UsageError} from '../errors/index.mts';
import type {Edge} from '../model/types.mts';
import {findNode, nodeRef} from './materialize.mts';

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
   *
   * "Every edge" means every edge the declaration could have named. A tracker
   * lists tickets, and an id it names that nobody has fetched yet is a
   * placeholder, so those two kinds are what a redeclaration replaces. Edges
   * whose other endpoint is a PR item or a milestone were minted here — a
   * worker registering the PR that implements a ticket, a scan recording
   * milestone membership — and no tracker relation list mentions them, so a
   * redeclaration that dropped them would be deleting on no evidence. Remove
   * one of those with `edge rm`, which says which edge it means.
   */
  async setEdges(
    node: string,
    direction: 'blockers' | 'blocks',
    others: readonly string[]
  ): Promise<void> {
    await this.#db.transaction(() => {
      const nodeId = nodeRef(this.#db, node);
      const [own, far] =
        direction === 'blockers'
          ? ['blocked', 'blocker']
          : ['blocker', 'blocked'];
      this.#db.run(
        `DELETE FROM edge
         WHERE ${own} = ?
           AND ${far} IN (
             SELECT id FROM node WHERE kind IN ('ticket', 'unknown')
           )`,
        [nodeId]
      );
      for (const other of others) {
        if (direction === 'blockers') this.#insert(other, node);
        else this.#insert(node, other);
      }
      this.#rejectIfCycle(node);
    });
  }

  /**
   * Put a ticket in exactly one milestone, or in none.
   *
   * Membership is an edge, and `setEdges` deliberately will not touch it: a
   * tracker's relation list never mentions a milestone, so a redeclaration of
   * blockers has no evidence about one. Nothing else replaces it either, which
   * is how a ticket moved from one milestone to the next ends up counted by
   * both gates. This is the write that says which one it is now.
   *
   * The milestone must already be recorded, for the reason a ticket's project
   * must be: an unrecorded id materializes an `unknown` placeholder, and a
   * ticket → placeholder edge is a blocking dependency, not a membership.
   */
  async setMilestone(ticket: string, milestone: string | null): Promise<void> {
    await this.#db.transaction(() => {
      if (milestone !== null) {
        const node = findNode(this.#db, milestone);
        ensure(
          node !== null && node.kind === 'milestone',
          () =>
            new UsageError(`"${milestone}" is not a recorded milestone`, {
              hint: 'record it first with `dispatch milestone set`, and pass the milestone id — a milestone name is not its id.',
            })
        );
      }
      const ticketId = nodeRef(this.#db, ticket);
      // `external_id = NULL` matches nothing, so the coalesced sentinel is what
      // makes a null milestone clear every membership rather than none.
      this.#db.run(
        `DELETE FROM edge
         WHERE blocker = ?
           AND blocked IN (SELECT node_id FROM milestone)
           AND blocked <> COALESCE(
             (SELECT id FROM node WHERE external_id = ?), -1)`,
        [ticketId, milestone]
      );
      if (milestone !== null) this.#insert(ticket, milestone);
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
