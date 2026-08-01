import {assertInstant} from '../db/time.mts';
import type {Database} from '../db/database.mts';
import {DataError, ensure} from '../errors/index.mts';
import {
  isStatus,
  isTargetKind,
  STATUS_LIST,
  TARGET_KIND_LIST,
} from '../model/status.mts';
import type {Ticket} from '../model/types.mts';
import {findNode, materialize, nodeRef} from './materialize.mts';

/* eslint-disable @typescript-eslint/require-await --
 * Async facade over synchronous `node:sqlite`; see `../db/database.mts`. */

export class TicketStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  async upsertTicket(ticket: Ticket): Promise<void> {
    ensure(
      isStatus(ticket.status),
      () =>
        new DataError(`"${ticket.status}" is not a status`, {
          hint: `use one of: ${STATUS_LIST}.`,
        })
    );
    ensure(
      isTargetKind(ticket.targetKind),
      () =>
        new DataError(`"${ticket.targetKind}" is not a target kind`, {
          hint: `use one of: ${TARGET_KIND_LIST}.`,
        })
    );
    if (ticket.updatedAt !== null)
      assertInstant(ticket.updatedAt, '--updated-at');

    await this.#db.transaction(() => {
      const projectId = nodeRef(this.#db, ticket.project);
      const nodeId = materialize(this.#db, ticket.id, 'ticket');
      this.#db.run(
        `INSERT INTO ticket (
           node_id, project_id, url, title, status, target_kind,
           requires_human, injected, priority, branch_hint, labels, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(node_id) DO UPDATE SET
           project_id = excluded.project_id, url = excluded.url,
           title = excluded.title, status = excluded.status,
           target_kind = excluded.target_kind,
           requires_human = excluded.requires_human,
           injected = excluded.injected, priority = excluded.priority,
           branch_hint = excluded.branch_hint, labels = excluded.labels,
           updated_at = excluded.updated_at`,
        [
          nodeId,
          projectId,
          ticket.url,
          ticket.title,
          ticket.status,
          ticket.targetKind,
          ticket.requiresHuman ? 1 : 0,
          ticket.injected ? 1 : 0,
          ticket.priority,
          ticket.branchHint,
          JSON.stringify(ticket.labels),
          ticket.updatedAt,
        ]
      );
    });
  }

  /** Remove a ticket; its satellite, edges, claim, and outcome cascade. */
  async removeTicket(id: string): Promise<boolean> {
    return this.#db.transaction(() => {
      const node = findNode(this.#db, id);
      if (node?.kind !== 'ticket') return false;
      this.#db.run('DELETE FROM node WHERE id = ?', [node.id]);
      return true;
    });
  }

  async getTicket(id: string): Promise<Ticket | null> {
    const row = this.#db.get(
      `SELECT n.external_id AS id, pn.external_id AS project, t.url, t.title,
              t.status, t.target_kind, t.requires_human, t.injected, t.priority,
              t.branch_hint, t.labels, t.updated_at
       FROM ticket t
       JOIN node n ON n.id = t.node_id
       JOIN node pn ON pn.id = t.project_id
       WHERE n.external_id = ?`,
      [id]
    );
    if (row === undefined) return null;
    return {
      id: String(row.id),
      project: String(row.project),
      url: String(row.url),
      title: String(row.title),
      status: row.status as Ticket['status'],
      targetKind: row.target_kind as Ticket['targetKind'],
      requiresHuman: row.requires_human === 1,
      injected: row.injected === 1,
      priority: row.priority === null ? null : Number(row.priority),
      branchHint:
        row.branch_hint === null
          ? null
          : (row.branch_hint as unknown as string),
      labels: JSON.parse(String(row.labels)) as string[],
      updatedAt:
        row.updated_at === null ? null : (row.updated_at as unknown as string),
    };
  }
}

/* eslint-enable @typescript-eslint/require-await */
