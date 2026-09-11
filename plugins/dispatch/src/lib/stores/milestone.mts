import type {Database} from '../db/database.mts';
import {ensure, UsageError} from '../errors/index.mts';
import type {Milestone} from '../model/types.mts';
import {findNode, materialize} from './materialize.mts';

/* eslint-disable @typescript-eslint/require-await --
 * Async facade over synchronous `node:sqlite`; see `../db/database.mts`. */

/**
 * Milestones. Membership is not stored here — a ticket belongs to a milestone by
 * blocking it (a `ticket → milestone` edge), so removing a milestone node lets
 * the edge FK cascade its membership away.
 */
export class MilestoneStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  async upsertMilestone(milestone: Milestone): Promise<void> {
    await this.#db.transaction(() => {
      // Same rule as tickets: the project must already be recorded. A name
      // passed where the id belongs would otherwise materialize an
      // unknown-kind placeholder and silently parent the milestone onto a
      // node no project join can see.
      const project = findNode(this.#db, milestone.project);
      ensure(
        project !== null && project.kind === 'project',
        () =>
          new UsageError(`"${milestone.project}" is not a recorded project`, {
            hint: 'record it first with `dispatch project set`, and pass the project id — a project name is not its id.',
          })
      );
      const projectId = project.id;
      const nodeId = materialize(this.#db, milestone.id, 'milestone');
      this.#db.run(
        `INSERT INTO milestone (node_id, project_id, name) VALUES (?, ?, ?)
         ON CONFLICT(node_id) DO UPDATE SET
           project_id = excluded.project_id, name = excluded.name`,
        [nodeId, projectId, milestone.name]
      );
    });
  }

  /** Remove a milestone; its edges, claim, and review cascade via node FKs. */
  async removeMilestone(id: string): Promise<boolean> {
    return this.#db.transaction(() => {
      const node = findNode(this.#db, id);
      if (node?.kind !== 'milestone') return false;
      this.#db.run('DELETE FROM node WHERE id = ?', [node.id]);
      return true;
    });
  }

  async getMilestone(id: string): Promise<Milestone | null> {
    const row = this.#db.get(
      `SELECT n.external_id AS id, pn.external_id AS project, m.name AS name
       FROM milestone m
       JOIN node n ON n.id = m.node_id
       JOIN node pn ON pn.id = m.project_id
       WHERE n.external_id = ?`,
      [id]
    );
    if (row === undefined) return null;
    return {
      id: String(row.id),
      project: String(row.project),
      name: String(row.name),
    };
  }
}

/* eslint-enable @typescript-eslint/require-await */
