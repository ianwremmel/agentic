import type {Database} from '../db/database.mts';
import {assertInstant} from '../db/time.mts';
import {DataError, ensure} from '../errors/index.mts';
import type {Observation} from '../watch/diff.mts';
import type {PrSnapshot} from '../watch/snapshot.mts';
import {findNode} from './materialize.mts';

/* eslint-disable @typescript-eslint/require-await --
 * Async facade over synchronous `node:sqlite`; see `../db/database.mts`. */

export interface DueWatch {
  node: string;
  repo: string;
  prNumber: number;
  /** The last observation, or null when none has been taken yet. */
  snapshot: PrSnapshot | null;
  /** Identity token for `observe`: a replacement watch mints a new one. */
  createdAt: string;
  /**
   * Past its expiry. The snapshot sees only the forge, so a signal outside it
   * — an approval given on the ticket, a reaction, an out-of-band go-ahead —
   * would otherwise never reach the worker. An expired watch fires with no
   * events attached, which tells the worker to go look for itself.
   */
  expired: boolean;
}

/**
 * A worker's PR wait, handed to the server. The worker records what it waits
 * on and returns; the server snapshots the PR on its tick, diffs against the
 * stored snapshot, and fires the row when something a worker would act on
 * changed. The row survives dispatch — a crashed resume still reads as a wait
 * to pick up — and is removed when the item's outcome is recorded.
 */
export class WatchStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  async set(input: {
    node: string;
    intervalSeconds: number;
    at: string;
    expiresAt: string;
    /**
     * The PR as of arming. Recording it here is what closes the gap between
     * the worker's last look and the first poll; null (the read failed)
     * degrades to priming on the first successful poll, which can miss a
     * change that landed in between.
     */
    snapshot: PrSnapshot | null;
    /** The session whose worker armed this wait; only it can route the events. */
    session: string | null;
    /**
     * Release this session's claim in the same transaction. The two must not
     * be separable: between a released claim and an installed watch the item
     * is neither claimed nor watching, so another server can claim and
     * dispatch it — and the late arm then hides that live worker's claim
     * behind a watching row.
     */
    releaseClaimFor?: string | null;
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
      if (input.releaseClaimFor != null) {
        this.#db.run('DELETE FROM claim WHERE node_id = ? AND session_id = ?', [
          node.id,
          input.releaseClaimFor,
        ]);
      }
      // Re-arming starts a new wait, so anything the previous one observed
      // and never delivered describes a wait nobody is in any more.
      this.#db.run('DELETE FROM pr_event WHERE node_id = ?', [node.id]);
      this.#db.run(
        `INSERT INTO watch (node_id, state, snapshot, interval_s, session_id, created_at, expires_at)
         VALUES (?, 'watching', ?, ?, ?, ?, ?)
         ON CONFLICT(node_id) DO UPDATE SET
           state = 'watching',
           snapshot = excluded.snapshot,
           interval_s = excluded.interval_s, checked_at = NULL,
           session_id = excluded.session_id,
           created_at = excluded.created_at, expires_at = excluded.expires_at`,
        [
          node.id,
          input.snapshot === null ? null : JSON.stringify(input.snapshot),
          input.intervalSeconds,
          input.session,
          input.at,
          input.expiresAt,
        ]
      );
    });
  }

  /**
   * Watching rows ready for a poll — expired, never checked, or past their
   * interval — oldest check first, capped so one pass stays short. A row
   * whose item lacks PR coordinates is skipped; there is nothing to read yet.
   */
  async due(now: string, limit: number): Promise<DueWatch[]> {
    assertInstant(now, 'now');
    return this.#db
      .all(
        `SELECT n.external_id AS node, pr.repo, pr.pr_number,
                w.snapshot, w.created_at,
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
        repo: String(row.repo),
        prNumber: Number(row.pr_number),
        // The column is TEXT, so sqlite hands back a string or null; the
        // typing is `unknown` and the guard is what narrows it.
        snapshot:
          typeof row.snapshot === 'string'
            ? (JSON.parse(row.snapshot) as PrSnapshot)
            : null,
        createdAt: String(row.created_at),
        expired: Number(row.expired) === 1,
      }));
  }

  /**
   * Record one poll's snapshot and the events it produced, and fire the watch
   * if the poll says so — all in one transaction. Splitting them lets a crash
   * land events for a wait that never fired, which the next tick would then
   * re-derive from the same unchanged snapshot and record a second time.
   *
   * A row replaced mid-poll (`createdAt` differs) is left alone, events and
   * all: the observation belongs to a wait that no longer exists.
   */
  async observe(input: {
    node: string;
    snapshot: PrSnapshot;
    at: string;
    createdAt: string;
    fire: boolean;
    intervalSeconds: number;
    expiresAt: string;
    events: readonly Observation[];
  }): Promise<'recorded' | 'fired' | 'stale'> {
    assertInstant(input.at, 'at');
    return this.#db.transaction(() => {
      const row = this.#db.get(
        `SELECT w.node_id, w.session_id FROM watch w
         JOIN node n ON n.id = w.node_id
         WHERE n.external_id = ? AND w.state = 'watching' AND w.created_at = ?`,
        [input.node, input.createdAt]
      );
      if (row === undefined) return 'stale';
      const nodeId = Number(row.node_id);
      for (const event of input.events) {
        this.#db.run(
          `INSERT INTO pr_event (node_id, kind, summary, meta, session_id, observed_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            nodeId,
            event.kind,
            event.summary,
            JSON.stringify(event.meta),
            typeof row.session_id === 'string' ? row.session_id : null,
            input.at,
          ]
        );
      }
      this.#db.run(
        `UPDATE watch SET snapshot = ?, checked_at = ?, state = ?,
                          interval_s = ?, expires_at = ?
         WHERE node_id = ?`,
        [
          JSON.stringify(input.snapshot),
          input.at,
          input.fire ? 'fired' : 'watching',
          input.intervalSeconds,
          input.expiresAt,
          nodeId,
        ]
      );
      return input.fire ? 'fired' : 'recorded';
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
   * Push a failed poll's retry out by one interval; same generation guard as
   * `observe`, so a failure observed against a replaced watch cannot delay
   * the replacement's first poll.
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

  /** The last snapshot a poll stored for a node, or null. */
  async latestSnapshot(node: string): Promise<PrSnapshot | null> {
    const row = this.#db.get(
      `SELECT w.snapshot FROM watch w
       JOIN node n ON n.id = w.node_id
       WHERE n.external_id = ?`,
      [node]
    );
    return typeof row?.snapshot === 'string'
      ? (JSON.parse(row.snapshot) as PrSnapshot)
      : null;
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

  /**
   * Open a watch on every PR item that has a PR and no outcome and is not
   * already watched. A PR moves whether or not a worker asked anyone to look,
   * and an unwatched item is exactly the one whose change goes unnoticed.
   */
  async ensureForLiveItems(at: string, expirySeconds: number): Promise<number> {
    assertInstant(at, 'at');
    const expiresAt = new Date(
      Date.parse(at) + expirySeconds * 1_000
    ).toISOString();
    return this.#db.run(
      `INSERT INTO watch (node_id, state, snapshot, interval_s, session_id, created_at, expires_at)
       SELECT pr.node_id, 'watching', NULL, 60, NULL, ?, ?
       FROM pr
       LEFT JOIN watch w ON w.node_id = pr.node_id
       LEFT JOIN outcome o ON o.node_id = pr.node_id
       WHERE pr.repo IS NOT NULL AND pr.pr_number IS NOT NULL
         AND w.node_id IS NULL AND o.node_id IS NULL`,
      [at, expiresAt]
    );
  }

  async get(node: string): Promise<{state: 'watching' | 'fired'} | null> {
    const row = this.#db.get(
      `SELECT w.state FROM watch w
       JOIN node n ON n.id = w.node_id
       WHERE n.external_id = ?`,
      [node]
    );
    if (row === undefined) return null;
    return {state: row.state as 'watching' | 'fired'};
  }
}

/* eslint-enable @typescript-eslint/require-await */
