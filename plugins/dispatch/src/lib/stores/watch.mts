import type {Database} from '../db/database.mts';
import {assertInstant} from '../db/time.mts';
import {DataError, ensure} from '../errors/index.mts';
import type {WatchReason} from '../model/status.mts';
import {findNode} from './materialize.mts';

/* eslint-disable @typescript-eslint/require-await --
 * Async facade over synchronous `node:sqlite`; see `../db/database.mts`. */

export interface DueWatch {
  node: string;
  reason: WatchReason;
  repo: string;
  prNumber: number;
  /** Identity token for `observe`: a replacement watch mints a new one. */
  createdAt: string;
  /** Past its expiry: fire without polling — the periodic safety net that
   * surfaces signals the fingerprint cannot see (out-of-band approvals,
   * reactions). */
  expired: boolean;
}

/**
 * Server-side waiting for PR items. A worker that reaches a wait point hands
 * the wait off as a `watching` row instead of polling in-band; the server
 * fingerprints the PR on its tick and flips the row to `fired` when the PR
 * changes, which re-queues the item as a `resume` pass. The row survives
 * dispatch — a crashed resume still reads as a wait to pick up — and is
 * removed when the item's outcome is recorded or replaced when the worker
 * arms a new wait.
 */
export class WatchStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  async set(input: {
    node: string;
    reason: WatchReason;
    intervalSeconds: number;
    at: string;
    expiresAt: string;
    /** The PR's fingerprint at arm time. Arming with the current state is
     * what closes the gap between the worker's last look and the first
     * poll; null (the fingerprint call failed) degrades to priming on the
     * first successful poll. */
    fingerprint: string | null;
  }): Promise<void> {
    assertInstant(input.at, 'at');
    assertInstant(input.expiresAt, 'expiresAt');
    await this.#db.transaction(() => {
      const node = findNode(this.#db, input.node);
      ensure(
        node !== null,
        () =>
          new DataError(`no node "${input.node}" to watch`, {
            hint: 'a watch is set on a PR item the graph already holds.',
          })
      );
      this.#db.run(
        `INSERT INTO watch (node_id, reason, state, fingerprint, interval_s, created_at, expires_at)
         VALUES (?, ?, 'watching', ?, ?, ?, ?)
         ON CONFLICT(node_id) DO UPDATE SET
           reason = excluded.reason, state = 'watching',
           fingerprint = excluded.fingerprint,
           interval_s = excluded.interval_s, checked_at = NULL,
           created_at = excluded.created_at, expires_at = excluded.expires_at`,
        [
          node.id,
          input.reason,
          input.fingerprint,
          input.intervalSeconds,
          input.at,
          input.expiresAt,
        ]
      );
    });
  }

  /**
   * Watching rows ready for a poll — expired, never checked, or past their
   * interval — oldest check first, capped at `limit` so one pass stays
   * short. A row whose item lacks PR coordinates is not returned; there is
   * nothing to fingerprint yet.
   */
  async due(now: string, limit: number): Promise<DueWatch[]> {
    assertInstant(now, 'now');
    return this.#db
      .all(
        `SELECT n.external_id AS node, w.reason, pr.repo, pr.pr_number,
                w.created_at,
                (unixepoch(?) >= unixepoch(w.expires_at)) AS expired
         FROM watch w
         JOIN node n ON n.id = w.node_id
         JOIN pr ON pr.node_id = w.node_id
         WHERE w.state = 'watching'
           AND pr.repo IS NOT NULL AND pr.pr_number IS NOT NULL
           AND (unixepoch(?) >= unixepoch(w.expires_at)
                OR w.checked_at IS NULL
                OR unixepoch(?) - unixepoch(w.checked_at) >= w.interval_s)
         ORDER BY w.checked_at IS NOT NULL, w.checked_at, n.external_id
         LIMIT ?`,
        [now, now, now, limit]
      )
      .map((row) => ({
        node: String(row.node),
        reason: row.reason as WatchReason,
        repo: String(row.repo),
        prNumber: Number(row.pr_number),
        createdAt: String(row.created_at),
        expired: Number(row.expired) === 1,
      }));
  }

  /**
   * Record one poll's fingerprint against the watch generation the poll saw.
   * A row replaced mid-poll (`createdAt` differs) is left alone — the
   * observation belongs to a wait that no longer exists.
   */
  async observe(
    node: string,
    fingerprint: string,
    at: string,
    createdAt: string
  ): Promise<'primed' | 'unchanged' | 'fired' | 'stale'> {
    assertInstant(at, 'at');
    return this.#db.transaction(() => {
      const row = this.#db.get(
        `SELECT w.node_id, w.fingerprint, w.created_at FROM watch w
         JOIN node n ON n.id = w.node_id
         WHERE n.external_id = ? AND w.state = 'watching'`,
        [node]
      );
      if (row === undefined || String(row.created_at) !== createdAt) {
        return 'stale';
      }
      if (row.fingerprint === null) {
        this.#db.run(
          'UPDATE watch SET fingerprint = ?, checked_at = ? WHERE node_id = ?',
          [fingerprint, at, Number(row.node_id)]
        );
        return 'primed';
      }
      if (row.fingerprint === fingerprint) {
        this.#db.run('UPDATE watch SET checked_at = ? WHERE node_id = ?', [
          at,
          Number(row.node_id),
        ]);
        return 'unchanged';
      }
      this.#db.run(
        `UPDATE watch SET state = 'fired', fingerprint = ?, checked_at = ?
         WHERE node_id = ?`,
        [fingerprint, at, Number(row.node_id)]
      );
      return 'fired';
    });
  }

  /** Fire a watch outright (expiry); same generation guard as `observe`. */
  async fire(
    node: string,
    at: string,
    createdAt: string
  ): Promise<'fired' | 'stale'> {
    assertInstant(at, 'at');
    return this.#db.transaction(() => {
      const changed = this.#db.run(
        `UPDATE watch SET state = 'fired', checked_at = ?
         WHERE node_id = (SELECT id FROM node WHERE external_id = ?)
           AND state = 'watching' AND created_at = ?`,
        [at, node, createdAt]
      );
      return changed > 0 ? 'fired' : 'stale';
    });
  }

  /**
   * Push a failed poll's retry out by one interval; same generation guard
   * as `observe`, so a failure observed against a replaced watch cannot
   * delay the replacement's first poll.
   */
  async touch(node: string, at: string, createdAt: string): Promise<void> {
    assertInstant(at, 'at');
    this.#db.run(
      `UPDATE watch SET checked_at = ?
       WHERE node_id = (SELECT id FROM node WHERE external_id = ?)
         AND created_at = ?`,
      [at, node, createdAt]
    );
  }

  async clear(node: string): Promise<boolean> {
    return (
      this.#db.run(
        `DELETE FROM watch
         WHERE node_id = (SELECT id FROM node WHERE external_id = ?)`,
        [node]
      ) > 0
    );
  }

  async get(
    node: string
  ): Promise<{reason: WatchReason; state: 'watching' | 'fired'} | null> {
    const row = this.#db.get(
      `SELECT w.reason, w.state FROM watch w
       JOIN node n ON n.id = w.node_id
       WHERE n.external_id = ?`,
      [node]
    );
    if (row === undefined) return null;
    return {
      reason: row.reason as WatchReason,
      state: row.state as 'watching' | 'fired',
    };
  }
}

/* eslint-enable @typescript-eslint/require-await */
