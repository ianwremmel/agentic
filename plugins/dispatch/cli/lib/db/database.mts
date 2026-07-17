import {mkdir} from 'node:fs/promises';
import {dirname} from 'node:path';
import {DatabaseSync} from 'node:sqlite';

import {DispatchError, EnvironmentError} from '../errors.mts';
import {SCHEMA, SCHEMA_VERSION} from './schema.mts';

export type SqlValue = string | number | null;
export type Row = Record<string, unknown>;

/* eslint-disable @typescript-eslint/require-await --
 * The async signatures are the point of this class. `node:sqlite` is synchronous
 * today; these methods are async so an async driver later is a change behind this
 * facade, not a rewrite of every call site. */

/**
 * The dispatch database: one SQLite file holding everything the CLI persists.
 * This class owns the connection — pragmas, schema bootstrap, version
 * enforcement, transactions — and nothing about what the tables mean; domain
 * stores (`../graph/store.mts`) sit on top of it.
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
          `cannot create the directory for the dispatch database at ${path}`,
          {
            cause,
            hint: 'check the path is writable, or point --db somewhere else.',
          }
        );
      }
    }

    try {
      const db = new DatabaseSync(path);
      db.exec('PRAGMA journal_mode = WAL');
      // Several agents share one database. Without a busy timeout SQLite fails
      // the moment it meets a concurrent writer, turning routine contention into
      // a hard error.
      db.exec('PRAGMA busy_timeout = 5000');
      // Off by default in SQLite; the schema's REFERENCES clauses are inert
      // without it.
      db.exec('PRAGMA foreign_keys = ON');

      const database = new Database(db);
      database.#enforceVersion(path);
      return database;
    } catch (cause) {
      if (cause instanceof DispatchError) throw cause;
      throw new EnvironmentError(
        `cannot open the dispatch database at ${path}`,
        {
          cause,
          hint: 'check the file is a readable, writable SQLite database and the disk is not full. If it is locked, another dispatch command is mid-write — retry shortly. Deleting the file forces a rebuild.',
        }
      );
    }
  }

  /**
   * Bootstrap the schema, refusing a file another schema version wrote. The
   * database is a rebuildable cache plus orchestrator bookkeeping; there is no
   * migration machinery, so a version mismatch is the caller's decision to
   * make, not something to paper over silently.
   */
  #enforceVersion(path: string): void {
    this.#db.exec(
      'CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT'
    );
    const row = this.#db
      .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
      .get();

    if (row !== undefined && row.value !== String(SCHEMA_VERSION)) {
      throw new EnvironmentError(
        `the dispatch database at ${path} uses schema version ${String(row.value)}; this CLI needs ${String(SCHEMA_VERSION)}`,
        {
          hint: 'delete the file and re-run a full sync. Claims and recorded reviews go with it — release or re-record what still matters first.',
        }
      );
    }

    this.#db.exec(SCHEMA);
    if (row === undefined) {
      this.#db
        .prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
        .run('schema_version', String(SCHEMA_VERSION));
    }
  }

  async close(): Promise<void> {
    this.#db.close();
  }

  async transaction<T>(body: () => T): Promise<T> {
    return this.guard(() => {
      // IMMEDIATE takes the write lock up front. Every transaction here writes
      // (or intends to), and a deferred BEGIN that reads first — claimNext
      // ranking the queue before inserting the claim — could not upgrade to a
      // writer if a concurrent connection committed in between; SQLite refuses
      // the upgrade instead of retrying the read.
      this.#db.exec('BEGIN IMMEDIATE');
      try {
        const result = body();
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

  /**
   * Turn a SQLite failure into an environment error. A locked or unwritable
   * database is a fact about the machine, not a mistake in how the CLI was
   * called — left unwrapped it reads as a bug in the CLI.
   */
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

  /** Run a statement; returns the number of changed rows. */
  run(sql: string, params: SqlValue[] = []): number {
    return this.guard(() =>
      Number(this.#db.prepare(sql).run(...params).changes)
    );
  }

  get(sql: string, params: SqlValue[] = []): Row | undefined {
    return this.guard(() => this.#db.prepare(sql).get(...params));
  }

  all(sql: string, params: SqlValue[] = []): Row[] {
    return this.guard(() => this.#db.prepare(sql).all(...params));
  }
}

/* eslint-enable @typescript-eslint/require-await */
