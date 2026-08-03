import {mkdir} from 'node:fs/promises';
import {dirname} from 'node:path';
import {DatabaseSync} from 'node:sqlite';

import {
  DefinitionError,
  DispatchError,
  EnvironmentError,
} from '../errors/index.mts';
import {SCHEMA, SCHEMA_VERSION} from './schema.mts';

export type SqlValue = string | number | null;
export type Row = Record<string, unknown>;

/* eslint-disable @typescript-eslint/require-await --
 * The async signatures are the point of this class. `node:sqlite` is synchronous
 * today; these methods are async so an async driver later is a change behind this
 * facade, not a rewrite of every call site. */

/**
 * The dispatch database: one SQLite file holding everything the CLI persists.
 * Owns the connection — pragmas, schema bootstrap, version enforcement,
 * transactions — and nothing about what the tables mean; the stores sit on top.
 */
export class Database {
  readonly #db: DatabaseSync;

  private constructor(db: DatabaseSync) {
    this.#db = db;
  }

  static async open(path: string): Promise<Database> {
    if (path !== ':memory:') {
      try {
        await mkdir(dirname(path), {recursive: true});
      } catch (cause) {
        throw new EnvironmentError(
          'cannot create the directory for the dispatch database',
          {cause, hint: 'check the path is writable, or point --db elsewhere.'}
        );
      }
    }
    try {
      const raw = new DatabaseSync(path);
      raw.exec('PRAGMA journal_mode = WAL');
      raw.exec('PRAGMA busy_timeout = 5000');
      raw.exec('PRAGMA foreign_keys = ON');
      const db = new Database(raw);
      db.#bootstrap(path);
      return db;
    } catch (cause) {
      if (cause instanceof DispatchError) throw cause;
      throw new EnvironmentError('cannot open the dispatch database', {
        cause,
        hint: 'check the file is a readable, writable SQLite database and the disk is not full. If it is locked, another dispatch command is mid-write — retry shortly. Deleting the file forces a rebuild.',
      });
    }
  }

  #bootstrap(path: string): void {
    this.#db.exec(
      'CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT'
    );
    const row = this.#db
      .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
      .get() as Row | undefined;
    Database.assertVersion(this, path, row?.value as string | undefined);
    this.#db.exec(SCHEMA);
    if (row === undefined) {
      this.#db
        .prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
        .run('schema_version', String(SCHEMA_VERSION));
    }
  }

  /**
   * Refuse a file another schema version wrote. Exposed static so a test can
   * exercise the guard without a second connection. `found` defaults to the
   * value recorded in `meta`.
   */
  static assertVersion(db: Database, path: string, found?: string): void {
    const recorded =
      found ??
      (db.get("SELECT value FROM meta WHERE key = 'schema_version'")?.value as
        string | undefined);
    if (recorded !== undefined && recorded !== String(SCHEMA_VERSION)) {
      throw new EnvironmentError(
        'the dispatch database was written by another schema version',
        {
          hint: 'delete the file and re-run a full sync. Claims and recorded reviews go with it — release or re-record what still matters first.',
        }
      );
    }
  }

  async close(): Promise<void> {
    this.#db.close();
  }

  /**
   * The body must be synchronous: COMMIT runs as soon as it returns, so an
   * async body would run its post-await statements outside the transaction.
   * A returned promise is therefore refused outright.
   */
  async transaction<T>(body: () => T): Promise<T> {
    return this.guard(() => {
      this.#db.exec('BEGIN IMMEDIATE');
      try {
        const result = body();
        if (result instanceof Promise) {
          throw new DefinitionError('transaction bodies must be synchronous', {
            hint: 'an async body would commit before its awaits ran; move the awaits outside the transaction.',
          });
        }
        this.#db.exec('COMMIT');
        return result;
      } catch (error) {
        try {
          this.#db.exec('ROLLBACK');
        } catch {
          // A failing ROLLBACK must not replace the error that caused it.
        }
        throw error;
      }
    });
  }

  guard<T>(body: () => T): T {
    try {
      return body();
    } catch (cause) {
      if (cause instanceof DispatchError) throw cause;
      throw new EnvironmentError(
        'the dispatch database rejected an operation',
        {
          cause,
          hint: 'if the database is locked, another dispatch command is mid-write — retry shortly. Otherwise check the file is a writable SQLite database and the disk is not full.',
        }
      );
    }
  }

  run(sql: string, params: SqlValue[] = []): number {
    return this.guard(() =>
      Number(this.#db.prepare(sql).run(...params).changes)
    );
  }

  get(sql: string, params: SqlValue[] = []): Row | undefined {
    return this.guard(
      () => this.#db.prepare(sql).get(...params) as Row | undefined
    );
  }

  all(sql: string, params: SqlValue[] = []): Row[] {
    return this.guard(() => this.#db.prepare(sql).all(...params) as Row[]);
  }
}

/* eslint-enable @typescript-eslint/require-await */
