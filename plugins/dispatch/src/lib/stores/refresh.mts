import type {Database} from '../db/database.mts';
import {assertInstant} from '../db/time.mts';

/* eslint-disable @typescript-eslint/require-await --
 * Async facade over synchronous `node:sqlite`; see `../db/database.mts`. */

export const REFRESH_STATES = ['scanning', 'resolving', 'idle'] as const;
export type RefreshState = (typeof REFRESH_STATES)[number];

export interface RefreshRow {
  source: string;
  state: RefreshState;
  sessionId: string | null;
  projects: string[];
  pendingCursor: string | null;
  startedAt: string;
  completedAt: string | null;
  completionEmittedAt: string | null;
}

const COLUMNS = `source, state, session_id, projects, pending_cursor,
                 started_at, completed_at, completion_emitted_at`;

/**
 * One row per tracker source: which phase its ingest is in, who owns it, and
 * whether its completion event still owes a push.
 */
export class RefreshStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  async open(input: {
    source: string;
    projects: readonly string[];
    sessionId: string | null;
    at: string;
  }): Promise<void> {
    assertInstant(input.at, 'at');
    this.#upsert(
      input.source,
      'scanning',
      input.sessionId,
      JSON.stringify([...input.projects]),
      input.at
    );
  }

  async openResolving(input: {
    source: string;
    sessionId: string | null;
    at: string;
  }): Promise<void> {
    assertInstant(input.at, 'at');
    this.#upsert(input.source, 'resolving', input.sessionId, '[]', input.at);
  }

  async setState(source: string, state: RefreshState): Promise<void> {
    this.#db.run('UPDATE refresh SET state = ? WHERE source = ?', [
      state,
      source,
    ]);
  }

  async setPendingCursor(source: string, cursor: string): Promise<void> {
    this.#db.run('UPDATE refresh SET pending_cursor = ? WHERE source = ?', [
      cursor,
      source,
    ]);
  }

  async close(source: string, at: string): Promise<void> {
    assertInstant(at, 'at');
    this.#db.run(
      `UPDATE refresh
       SET state = 'idle', completed_at = ?, completion_emitted_at = NULL,
           pending_cursor = NULL
       WHERE source = ?`,
      [at, source]
    );
  }

  async markCompletionEmitted(source: string, at: string): Promise<void> {
    assertInstant(at, 'at');
    this.#db.run(
      'UPDATE refresh SET completion_emitted_at = ? WHERE source = ?',
      [at, source]
    );
  }

  async pendingCompletions(): Promise<string[]> {
    return this.#db
      .all(
        `SELECT source FROM refresh
         WHERE completed_at IS NOT NULL AND completion_emitted_at IS NULL
         ORDER BY source`
      )
      .map((row) => String(row.source));
  }

  async hasLiveSession(source: string): Promise<boolean> {
    return (
      this.#db.get(
        `SELECT 1 FROM refresh r
         JOIN session s ON s.id = r.session_id
         WHERE r.source = ?`,
        [source]
      ) !== undefined
    );
  }

  async get(source: string): Promise<RefreshRow | null> {
    const row = this.#db.get(
      `SELECT ${COLUMNS} FROM refresh WHERE source = ?`,
      [source]
    );
    return row === undefined ? null : toRow(row);
  }

  async active(): Promise<RefreshRow[]> {
    return this.#db
      .all(
        `SELECT ${COLUMNS} FROM refresh WHERE state <> 'idle' ORDER BY source`
      )
      .map(toRow);
  }

  #upsert(
    source: string,
    state: RefreshState,
    sessionId: string | null,
    projects: string,
    at: string
  ): void {
    this.#db.run(
      `INSERT INTO refresh (${COLUMNS})
       VALUES (?, ?, ?, ?, NULL, ?, NULL, NULL)
       ON CONFLICT(source) DO UPDATE SET
         state = excluded.state, session_id = excluded.session_id,
         projects = excluded.projects, pending_cursor = NULL,
         started_at = excluded.started_at, completed_at = NULL,
         completion_emitted_at = NULL`,
      [source, state, sessionId, projects, at]
    );
  }
}

/* eslint-disable @typescript-eslint/no-base-to-string --
 * Database values are known to be primitives; avoid as-casts per brief. */
function toRow(row: Record<string, unknown>): RefreshRow {
  return {
    source: String(row.source),
    state: row.state as RefreshState,
    sessionId: row.session_id === null ? null : String(row.session_id),
    projects: JSON.parse(String(row.projects)) as string[],
    pendingCursor:
      row.pending_cursor === null ? null : String(row.pending_cursor),
    startedAt: String(row.started_at),
    completedAt: row.completed_at === null ? null : String(row.completed_at),
    completionEmittedAt:
      row.completion_emitted_at === null
        ? null
        : String(row.completion_emitted_at),
  };
}
/* eslint-enable @typescript-eslint/no-base-to-string */

/* eslint-enable @typescript-eslint/require-await */
