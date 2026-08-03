import type {Database} from '../db/database.mts';
import {assertInstant} from '../db/time.mts';
import {DataError, ensure} from '../errors/index.mts';
import type {Session} from '../model/types.mts';

/* eslint-disable @typescript-eslint/require-await --
 * Async facade over synchronous `node:sqlite`; see `../db/database.mts`. */

/**
 * Sessions: one row per live MCP server process, the only liveness primitive.
 * Claims and slots reference a session and cascade when it is deleted — on a
 * clean `close`, or when `sweepStale` reaps a process whose heartbeat stopped.
 */
export class SessionStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  async register(session: {
    id: string;
    host?: string | null;
    pid?: number | null;
    startedAt: string;
    heartbeatAt: string;
  }): Promise<void> {
    assertInstant(session.startedAt, 'startedAt');
    assertInstant(session.heartbeatAt, 'heartbeatAt');
    this.#db.run(
      `INSERT INTO session (id, host, pid, started_at, heartbeat_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         host = excluded.host, pid = excluded.pid,
         heartbeat_at = excluded.heartbeat_at`,
      [
        session.id,
        session.host ?? null,
        session.pid ?? null,
        session.startedAt,
        session.heartbeatAt,
      ]
    );
  }

  async heartbeat(id: string, at: string): Promise<boolean> {
    assertInstant(at, 'at');
    return (
      this.#db.run('UPDATE session SET heartbeat_at = ? WHERE id = ?', [
        at,
        id,
      ]) > 0
    );
  }

  /** Clean exit: delete the session; its claims and slots cascade. */
  async close(id: string): Promise<boolean> {
    return this.#db.run('DELETE FROM session WHERE id = ?', [id]) > 0;
  }

  /**
   * Reap sessions whose heartbeat is older than `windowSeconds` before `now`.
   * The staleness sweep is the only place liveness is judged by age. Returns the
   * number of sessions removed (their claims and slots cascade).
   */
  async sweepStale(now: string, windowSeconds: number): Promise<number> {
    assertInstant(now, 'now');
    ensure(
      Number.isFinite(windowSeconds) && windowSeconds >= 0,
      () =>
        new DataError(`"${String(windowSeconds)}" is not a staleness window`, {
          hint: 'pass a non-negative number of seconds; a negative window would sweep every live session.',
        })
    );
    return this.#db.run(
      'DELETE FROM session WHERE unixepoch(?) - unixepoch(heartbeat_at) > ?',
      [now, windowSeconds]
    );
  }

  /* eslint-disable @typescript-eslint/no-base-to-string --
   * Database values are known to be primitives; avoid as-casts per brief. */
  async getSession(id: string): Promise<Session | null> {
    const row = this.#db.get(
      `SELECT id, host, pid, started_at, heartbeat_at
       FROM session WHERE id = ?`,
      [id]
    );
    if (row === undefined) return null;
    return {
      id: String(row.id),
      host: row.host === null ? null : String(row.host),
      pid: row.pid === null ? null : Number(row.pid),
      startedAt: String(row.started_at),
      heartbeatAt: String(row.heartbeat_at),
    };
  }
  /* eslint-enable @typescript-eslint/no-base-to-string */
}

/* eslint-enable @typescript-eslint/require-await */
