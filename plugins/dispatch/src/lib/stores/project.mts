import type {Database} from '../db/database.mts';
import type {Project} from '../model/types.mts';
import {findNode, materialize} from './materialize.mts';

/* eslint-disable @typescript-eslint/require-await --
 * Async facade over synchronous `node:sqlite`; see `../db/database.mts`. */

/** Projects: the 1:1 scoping partition tickets and milestones belong to. */
export class ProjectStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  async upsertProject(project: {
    id: string;
    name: string;
    source?: string | null;
  }): Promise<void> {
    await this.#db.transaction(() => {
      const nodeId = materialize(this.#db, project.id, 'project');
      this.#db.run(
        `INSERT INTO project (node_id, name, source) VALUES (?, ?, ?)
         ON CONFLICT(node_id) DO UPDATE SET
           name = excluded.name, source = excluded.source`,
        [nodeId, project.name, project.source ?? null]
      );
    });
  }

  /**
   * Remove a project. If a ticket or milestone still names it, demote its node
   * to an `unknown` placeholder (the reference stays valid); otherwise delete
   * the node outright. Returns whether a declared project was found.
   */
  async removeProject(id: string): Promise<boolean> {
    return this.#db.transaction(() => {
      const node = findNode(this.#db, id);
      if (node?.kind !== 'project') return false;
      const referenced =
        this.#db.get(
          `SELECT 1 FROM ticket WHERE project_id = ?
           UNION SELECT 1 FROM milestone WHERE project_id = ? LIMIT 1`,
          [node.id, node.id]
        ) !== undefined;
      this.#db.run('DELETE FROM project WHERE node_id = ?', [node.id]);
      if (referenced) {
        this.#db.run("UPDATE node SET kind = 'unknown' WHERE id = ?", [
          node.id,
        ]);
      } else {
        this.#db.run('DELETE FROM node WHERE id = ?', [node.id]);
      }
      return true;
    });
  }

  /* eslint-disable @typescript-eslint/no-base-to-string --
   * Database values are known to be primitives; avoid as-casts per brief. */
  async getProject(id: string): Promise<Project | null> {
    const row = this.#db.get(
      `SELECT n.external_id AS id, p.name AS name, p.source AS source
       FROM project p JOIN node n ON n.id = p.node_id
       WHERE n.external_id = ?`,
      [id]
    );
    if (row === undefined) return null;
    return {
      id: String(row.id),
      name: String(row.name),
      source: row.source === null ? null : String(row.source),
    };
  }
  /* eslint-enable @typescript-eslint/no-base-to-string */
}

/* eslint-enable @typescript-eslint/require-await */
