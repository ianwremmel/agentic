import {assertInstant} from '../db/time.mts';
import type {Database} from '../db/database.mts';
import {DataError, ensure} from '../errors/index.mts';
import {isPrOrigin, PR_ORIGIN_LIST} from '../model/status.mts';
import type {Pr} from '../model/types.mts';
import {findNode, materialize, nodeRef} from './materialize.mts';

/* eslint-disable @typescript-eslint/require-await --
 * Async facade over synchronous `node:sqlite`; see `../db/database.mts`. */

/** A partial write: `id` names the item, every other key is optional. */
export type PrPatch = Partial<Omit<Pr, 'id'>> & {id: string};

function pick<K extends keyof Pr>(
  patch: PrPatch,
  key: K,
  fallback: Pr[K]
): Pr[K] {
  const given = patch[key];
  return given === undefined ? fallback : (given as Pr[K]);
}

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
      this.#write(pr);
    });
  }

  #write(pr: Pr): void {
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
  }

  /**
   * Write only the fields the caller named, leaving the rest as they are.
   *
   * The full-record `upsertPr` is for a writer that holds the whole record —
   * an adoption sweep reading the forge. A worker does not: its documented job
   * is to keep the URL and PR number current as they come to exist, and it
   * knows nothing about the ticket link or title the item was registered with.
   * Assigning every column from a write like that silently unlinks the item
   * from its ticket and resets its origin, which drops it out of every
   * project-scoped view.
   *
   * Omitting a field preserves it; passing an explicit value — `null`
   * included — sets it. An id with no row yet is created, taking the same
   * defaults a bare registration would.
   */
  async patchPr(patch: PrPatch): Promise<void> {
    const {origin} = patch;
    if (origin !== undefined) {
      ensure(
        isPrOrigin(origin),
        () =>
          new DataError(`"${origin}" is not a pr origin`, {
            hint: `use one of: ${PR_ORIGIN_LIST}.`,
          })
      );
    }
    if (patch.updatedAt != null) assertInstant(patch.updatedAt, '--updated-at');

    await this.#db.transaction(() => {
      const existing = this.#read(patch.id);
      const merged: Pr = {
        id: patch.id,
        ticket: pick(patch, 'ticket', existing?.ticket ?? null),
        origin: pick(patch, 'origin', existing?.origin ?? 'prompt'),
        repo: pick(patch, 'repo', existing?.repo ?? null),
        prNumber: pick(patch, 'prNumber', existing?.prNumber ?? null),
        url: pick(patch, 'url', existing?.url ?? null),
        branch: pick(patch, 'branch', existing?.branch ?? null),
        title: pick(patch, 'title', existing?.title ?? ''),
        injected: pick(patch, 'injected', existing?.injected ?? false),
        priority: pick(patch, 'priority', existing?.priority ?? null),
        updatedAt: pick(patch, 'updatedAt', existing?.updatedAt ?? null),
      };
      this.#write(merged);
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
    return this.#read(id);
  }

  #read(id: string): Pr | null {
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
