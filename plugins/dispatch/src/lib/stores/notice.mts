import type {Database} from '../db/database.mts';
import {assertInstant} from '../db/time.mts';

/* eslint-disable @typescript-eslint/require-await --
 * Async facade over synchronous `node:sqlite`; see `../db/database.mts`. */

export const NOTICE_KINDS = [
  'park_human_blocked',
  'alert_failure',
  'project_complete',
] as const;
export type NoticeKind = (typeof NOTICE_KINDS)[number];

/**
 * Once-per-episode markers for the condition orders. A condition (a ticket
 * needs parking, a failure needs surfacing, a project completed) fires one
 * order while it holds; `prune` clears markers whose condition lapsed so a new
 * episode fires again.
 */
export class NoticeStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  async has(kind: NoticeKind, node: string): Promise<boolean> {
    return (
      this.#db.get('SELECT 1 AS x FROM notice WHERE kind = ? AND node = ?', [
        kind,
        node,
      ]) !== undefined
    );
  }

  async record(kind: NoticeKind, node: string, at: string): Promise<void> {
    assertInstant(at, 'at');
    this.#db.run(
      `INSERT INTO notice (kind, node, emitted_at) VALUES (?, ?, ?)
       ON CONFLICT(kind, node) DO NOTHING`,
      [kind, node, at]
    );
  }

  /** Drop every marker of `kind` whose node is not in `holding`. */
  async prune(kind: NoticeKind, holding: readonly string[]): Promise<number> {
    const placeholders = holding.map(() => '?').join(', ');
    return this.#db.run(
      holding.length === 0
        ? 'DELETE FROM notice WHERE kind = ?'
        : `DELETE FROM notice WHERE kind = ? AND node NOT IN (${placeholders})`,
      [kind, ...holding]
    );
  }
}

/* eslint-enable @typescript-eslint/require-await */
