/**
 * The run's state: the compute-slot ledger, liveness locks, the active set, and
 * the injection queue.
 *
 * One SQLite database per run. Every operation here is a single statement or a
 * transaction, so the concurrency this file used to hand-roll — atomic claims,
 * torn-write avoidance, read-modify-write on the active set — is the database's
 * problem now, and it is the thing databases are for.
 */

import {mkdirSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';

/** How long to wait for another agent's write before giving up. */
const BUSY_TIMEOUT_MS = 5_000;

export interface Slot {
  id: number;
  owner: string;
}

export interface Lock {
  key: string;
  agent_id: string;
  kind: string;
  heartbeat: number;
}

export interface Unit {
  key: string;
  state: string;
  detail: string | null;
}

export interface Injection {
  id: number;
  payload: string;
}

/**
 * Open (and migrate) the run's database.
 *
 * WAL lets a reader run while a writer commits — several agents heartbeat and
 * read this concurrently — and the busy timeout makes a contended write wait its
 * turn instead of failing.
 */
export function open(runDir: string): DatabaseSync {
  mkdirSync(join(runDir, 'units'), {recursive: true});
  const db = new DatabaseSync(join(runDir, 'state.db'), {timeout: BUSY_TIMEOUT_MS});
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS slot (
      id    INTEGER PRIMARY KEY,
      owner TEXT NOT NULL UNIQUE,
      beat  INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS lock (
      key       TEXT PRIMARY KEY,
      agent_id  TEXT NOT NULL,
      kind      TEXT NOT NULL,
      heartbeat INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS unit (
      key      TEXT PRIMARY KEY,
      state    TEXT NOT NULL,
      detail   TEXT,
      injected INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS injection (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      payload TEXT NOT NULL,
      drained INTEGER NOT NULL DEFAULT 0
    );
  `);
  return db;
}

const now = (): number => Math.floor(Date.now() / 1000);

/**
 * Take one ledger entry for `owner`.
 *
 * The insert picks the lowest free entry id below the bound, so the bound is
 * enforced by the statement itself: two agents racing cannot both win, and an
 * agent that already holds an entry cannot take a second under the same owner
 * (`owner` is unique — which is why owners must be per-build, not per-agent).
 *
 * @returns the entry id, or null when the ledger is full
 */
export function acquireSlot(db: DatabaseSync, owner: string, max: number): number | null {
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO slot (id, owner, beat)
       SELECT id, ?, ?
       FROM (
         WITH RECURSIVE n(id) AS (SELECT 1 UNION ALL SELECT id + 1 FROM n WHERE id < ?)
         SELECT id FROM n WHERE id NOT IN (SELECT id FROM slot) ORDER BY id LIMIT 1
       )`,
    )
    .run(owner, now(), max);
  if (result.changes === 0) return null;
  return Number(result.lastInsertRowid);
}

/** Release the caller's own entry. Returns false if it held none. */
export function releaseSlot(db: DatabaseSync, owner: string): boolean {
  return db.prepare('DELETE FROM slot WHERE owner = ?').run(owner).changes > 0;
}

/** Refresh the caller's own entry. Returns false if it held none. */
export function heartbeatSlot(db: DatabaseSync, owner: string): boolean {
  return db.prepare('UPDATE slot SET beat = ? WHERE owner = ?').run(now(), owner).changes > 0;
}

/** Reclaim entries whose owner stopped heartbeating: a crash must not leak capacity. */
export function reapSlots(db: DatabaseSync, staleSecs: number): Slot[] {
  const dead = db
    .prepare('SELECT id, owner FROM slot WHERE beat < ?')
    .all(now() - staleSecs) as unknown as Slot[];
  db.prepare('DELETE FROM slot WHERE beat < ?').run(now() - staleSecs);
  return dead;
}

export function freeSlots(db: DatabaseSync, max: number): number {
  const held = db.prepare('SELECT COUNT(*) AS n FROM slot').get() as unknown as {n: number};
  return max - held.n;
}

/** Claim a unit. Returns the current holder's id when someone else has it. */
export function acquireLock(
  db: DatabaseSync,
  key: string,
  agentId: string,
  kind: string,
): {ok: true} | {ok: false; heldBy: string} {
  const result = db
    .prepare('INSERT OR IGNORE INTO lock (key, agent_id, kind, heartbeat) VALUES (?, ?, ?, ?)')
    .run(key, agentId, kind, now());
  if (result.changes > 0) return {ok: true};
  const held = db.prepare('SELECT agent_id FROM lock WHERE key = ?').get(key) as unknown as
    | {agent_id: string}
    | undefined;
  return {ok: false, heldBy: held?.agent_id ?? 'unknown'};
}

export function heartbeatLock(db: DatabaseSync, key: string): boolean {
  return db.prepare('UPDATE lock SET heartbeat = ? WHERE key = ?').run(now(), key).changes > 0;
}

export function releaseLock(db: DatabaseSync, key: string): void {
  db.prepare('DELETE FROM lock WHERE key = ?').run(key);
}

/** A unit is live while its lock is fresh. A tick re-dispatches anything else. */
export function lockLive(db: DatabaseSync, key: string, staleSecs: number): boolean {
  const row = db
    .prepare('SELECT 1 AS live FROM lock WHERE key = ? AND heartbeat >= ?')
    .get(key, now() - staleSecs);
  return row !== undefined;
}

/** Clear locks whose owner died, so their work can be picked up again. */
export function sweepLocks(db: DatabaseSync, staleSecs: number): Lock[] {
  const cutoff = now() - staleSecs;
  const dead = db
    .prepare('SELECT key, agent_id, kind, heartbeat FROM lock WHERE heartbeat < ?')
    .all(cutoff) as unknown as Lock[];
  db.prepare('DELETE FROM lock WHERE heartbeat < ?').run(cutoff);
  return dead;
}

export function listLocks(db: DatabaseSync): Lock[] {
  return db
    .prepare('SELECT key, agent_id, kind, heartbeat FROM lock ORDER BY key')
    .all() as unknown as Lock[];
}

/**
 * Record a unit's state. One statement, so two ticks writing at once cannot lose
 * each other's update — the failure the file-based active set could not avoid.
 */
export function putUnit(db: DatabaseSync, key: string, state: string, detail?: string): void {
  db.prepare(
    `INSERT INTO unit (key, state, detail) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET state = excluded.state, detail = excluded.detail`,
  ).run(key, state, detail ?? null);
}

export function dropUnit(db: DatabaseSync, key: string): void {
  db.prepare('DELETE FROM unit WHERE key = ?').run(key);
}

export function listUnits(db: DatabaseSync): Unit[] {
  return db
    .prepare('SELECT key, state, detail FROM unit ORDER BY key')
    .all() as unknown as Unit[];
}

/** Every unit key, whatever its state. */
export function unitKeys(db: DatabaseSync): string[] {
  return (db.prepare('SELECT key FROM unit ORDER BY key').all() as unknown as Unit[]).map(
    (u) => u.key,
  );
}

/**
 * The ids kept off the frontier: work in flight, deferred, failed, or parked.
 *
 * A ticket that is only *injected* is deliberately not here. It has not been
 * dispatched yet — it is waiting to be, at the top of the frontier — and
 * excluding it would hide the very work the injection asked for.
 */
export function excludedKeys(db: DatabaseSync): string[] {
  return (
    db
      .prepare("SELECT key FROM unit WHERE state != 'injected' ORDER BY key")
      .all() as unknown as Unit[]
  ).map((u) => u.key);
}

/**
 * Mark a ticket as injected: it ranks at the top of the frontier until its work
 * reaches a terminal outcome. Idempotent, and it survives a tick that had no
 * capacity to dispatch it.
 */
export function inject(db: DatabaseSync, key: string): void {
  db.prepare(
    `INSERT INTO unit (key, state, injected) VALUES (?, 'injected', 1)
     ON CONFLICT(key) DO UPDATE SET injected = 1`,
  ).run(key);
}

export function uninject(db: DatabaseSync, key: string): void {
  db.prepare("UPDATE unit SET injected = 0 WHERE key = ?").run(key);
  db.prepare("DELETE FROM unit WHERE key = ? AND state = 'injected'").run(key);
}

export function injectedKeys(db: DatabaseSync): string[] {
  return (
    db.prepare('SELECT key FROM unit WHERE injected = 1 ORDER BY key').all() as unknown as Unit[]
  ).map((u) => u.key);
}

/** Queue ad-hoc work for the next tick. */
export function queueInjection(db: DatabaseSync, payload: string): void {
  JSON.parse(payload); // reject junk at the door rather than at drain time
  db.prepare('INSERT INTO injection (payload) VALUES (?)').run(payload);
}

/**
 * Take everything queued since the last drain.
 *
 * The read and the mark happen in one transaction, so an item is handed to
 * exactly one tick.
 */
export function drainInjections(db: DatabaseSync): unknown[] {
  const rows = db
    .prepare('SELECT id, payload FROM injection WHERE drained = 0 ORDER BY id')
    .all() as unknown as Injection[];
  if (rows.length === 0) return [];
  db.exec('BEGIN IMMEDIATE');
  try {
    const mark = db.prepare('UPDATE injection SET drained = 1 WHERE id = ?');
    for (const row of rows) mark.run(row.id);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return rows.map((row) => JSON.parse(row.payload) as unknown);
}

/**
 * Where a unit writes its `outcome.xml`.
 *
 * The directory is named by the unit's rowid, so two keys can never collide on a
 * sanitized path — the key itself stays in the database, where punctuation is
 * just punctuation.
 */
export function unitDir(db: DatabaseSync, runDir: string, key: string): string {
  db.prepare("INSERT OR IGNORE INTO unit (key, state) VALUES (?, 'unknown')").run(key);
  const row = db.prepare('SELECT rowid AS id FROM unit WHERE key = ?').get(key) as unknown as {
    id: number;
  };
  const dir = join(runDir, 'units', String(row.id));
  mkdirSync(dir, {recursive: true});
  return dir;
}

/**
 * Drop a unit: its lock, its row, and its artifacts.
 *
 * Removing the directory is not housekeeping. SQLite reuses a rowid once its row
 * is gone, so a stale `outcome.xml` left behind would be read as the *next*
 * unit's outcome — the orchestrator would reconcile a freshly dispatched
 * coordinator against its predecessor's result.
 */
export function cleanupUnit(db: DatabaseSync, runDir: string, key: string): void {
  const dir = unitDir(db, runDir, key);
  rmSync(dir, {recursive: true, force: true});
  releaseLock(db, key);
  dropUnit(db, key);
}
