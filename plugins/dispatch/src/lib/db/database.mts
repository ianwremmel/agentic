import {mkdir, rm} from 'node:fs/promises';
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
      const open = (): Database => {
        const raw = new DatabaseSync(path);
        raw.exec('PRAGMA journal_mode = WAL');
        raw.exec('PRAGMA busy_timeout = 5000');
        raw.exec('PRAGMA foreign_keys = ON');
        return new Database(raw);
      };
      let db = open();
      const stale = db.#staleVersion();
      if (stale === null) {
        db.#bootstrap();
        return db;
      }
      // The database is a rebuildable cache — the graph re-derives from a
      // full sync, and sessions and claims are runtime state — so a version
      // it cannot read is not an error to report, it is a file to replace.
      //
      // Refusing instead was worse than useless in practice: an MCP server
      // that exits on startup is not restarted by the runner, so the session
      // loses its channel permanently and silently, and only a human
      // deleting the file brings it back. Rebuilding costs one re-sync.
      await db.close();
      await Database.#discard(path, stale);
      db = open();
      db.#bootstrap();
      return db;
    } catch (cause) {
      if (cause instanceof DispatchError) throw cause;
      throw new EnvironmentError('cannot open the dispatch database', {
        cause,
        hint: 'check the file is a readable, writable SQLite database and the disk is not full. If it is locked, another dispatch command is mid-write — retry shortly. Deleting the file forces a rebuild.',
      });
    }
  }

  /** The version this file records, when it is one this build cannot read. */
  #staleVersion(): string | null {
    this.#db.exec(
      'CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT'
    );
    const row = this.#db
      .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
      .get() as Row | undefined;
    const recorded = row?.value as string | undefined;
    return recorded !== undefined && recorded !== String(SCHEMA_VERSION)
      ? recorded
      : null;
  }

  /** Remove a database this build cannot read, and its WAL sidecars. */
  static async #discard(path: string, was: string): Promise<void> {
    if (path === ':memory:') return;
    for (const suffix of ['', '-wal', '-shm']) {
      await rm(`${path}${suffix}`, {force: true}).catch(() => undefined);
    }
    process.stderr.write(
      `dispatch: replaced the database at ${path}, written by schema version ${was}, with an empty one for version ${String(SCHEMA_VERSION)}. The graph rebuilds on the next refresh; any claims and recorded reviews it held are gone.\n`
    );
  }

  #bootstrap(): void {
    this.#db.exec(
      'CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT'
    );
    this.#db.exec(SCHEMA);
    this.#db
      .prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
      .run('schema_version', String(SCHEMA_VERSION));
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
