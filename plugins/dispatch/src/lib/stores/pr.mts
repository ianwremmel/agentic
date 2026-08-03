import {assertInstant} from '../db/time.mts';
import type {Database} from '../db/database.mts';
import {DataError, ensure} from '../errors/index.mts';
import {isPrOrigin, PR_ORIGIN_LIST} from '../model/status.mts';
import type {Pr} from '../model/types.mts';
import {findNode, materialize, nodeRef} from './materialize.mts';

/* eslint-disable @typescript-eslint/require-await --
 * Async facade over synchronous `node:sqlite`; see `../db/database.mts`. */

export class PrStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  async upsertPr(pr: Pr): Promise<void> {
    ensure(
      isPrOrigin(pr.origin),
      () =>
        new DataError(`"${pr.origin}" is not a pr origin`, {
          hint: `use one of: ${PR_ORIGIN_LIST}.`,
        })
    );
    if (pr.updatedAt !== null) assertInstant(pr.updatedAt, '--updated-at');

    await this.#db.transaction(() => {
      const nodeId = materialize(this.#db, pr.id, 'pr');
      const ticketId = pr.ticket === null ? null : nodeRef(this.#db, pr.ticket);
      this.#db.run(
        `INSERT INTO pr (
           node_id, ticket_id, origin, repo, pr_number, url, branch, title,
           injected, priority, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(node_id) DO UPDATE SET
           ticket_id = excluded.ticket_id, origin = excluded.origin,
           repo = excluded.repo, pr_number = excluded.pr_number,
           url = excluded.url, branch = excluded.branch, title = excluded.title,
           injected = excluded.injected, priority = excluded.priority,
           updated_at = excluded.updated_at`,
        [
          nodeId,
          ticketId,
          pr.origin,
          pr.repo,
          pr.prNumber,
          pr.url,
          pr.branch,
          pr.title,
          pr.injected ? 1 : 0,
          pr.priority,
          pr.updatedAt,
        ]
      );
    });
  }

  async removePr(id: string): Promise<boolean> {
    return this.#db.transaction(() => {
      const node = findNode(this.#db, id);
      if (node?.kind !== 'pr') return false;
      this.#db.run('DELETE FROM node WHERE id = ?', [node.id]);
      return true;
    });
  }

  /* eslint-disable @typescript-eslint/no-base-to-string --
   * SQLite hands back `unknown`; `String()` converts a primitive rather than
   * asserting a type the row has not been checked for. */
  async getPr(id: string): Promise<Pr | null> {
    const row = this.#db.get(
      `SELECT n.external_id AS id, tn.external_id AS ticket, p.origin, p.repo,
              p.pr_number, p.url, p.branch, p.title, p.injected, p.priority,
              p.updated_at
       FROM pr p
       JOIN node n ON n.id = p.node_id
       LEFT JOIN node tn ON tn.id = p.ticket_id
       WHERE n.external_id = ?`,
      [id]
    );
    if (row === undefined) return null;
    return {
      id: String(row.id),
      ticket: row.ticket === null ? null : String(row.ticket),
      origin: row.origin as Pr['origin'],
      repo: row.repo === null ? null : String(row.repo),
      prNumber: row.pr_number === null ? null : Number(row.pr_number),
      url: row.url === null ? null : String(row.url),
      branch: row.branch === null ? null : String(row.branch),
      title: String(row.title),
      injected: row.injected === 1,
      priority: row.priority === null ? null : Number(row.priority),
      updatedAt: row.updated_at === null ? null : String(row.updated_at),
    };
  }
  /* eslint-enable @typescript-eslint/no-base-to-string */
}

/* eslint-enable @typescript-eslint/require-await */
