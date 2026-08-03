import type {Database} from '../db/database.mts';

/* eslint-disable @typescript-eslint/require-await --
 * Async facade over synchronous `node:sqlite`; see `../db/database.mts`. */

/** Opaque per-source delta-sync cursors persisted between ticks. */
export class CursorStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  async getCursor(source: string): Promise<string | null> {
    const row = this.#db.get('SELECT value FROM cursor WHERE source = ?', [
      source,
    ]);
    return row === undefined ? null : String(row.value);
  }

  async setCursor(source: string, value: string): Promise<void> {
    this.#db.run(
      `INSERT INTO cursor (source, value) VALUES (?, ?)
       ON CONFLICT(source) DO UPDATE SET value = excluded.value`,
      [source, value]
    );
  }

  async clearCursor(source: string): Promise<boolean> {
    return this.#db.run('DELETE FROM cursor WHERE source = ?', [source]) > 0;
  }

  /** Clear every cursor. The graph-wide rebuild deletes all sources' nodes, so
   *  every source must re-sync from scratch or it silently keeps a cursor
   *  pointing past data that no longer exists. */
  async clearAllCursors(): Promise<number> {
    return this.#db.run('DELETE FROM cursor');
  }
}

/* eslint-enable @typescript-eslint/require-await */
