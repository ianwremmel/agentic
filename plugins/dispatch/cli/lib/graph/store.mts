import {mkdir} from 'node:fs/promises';
import {dirname} from 'node:path';
import {DatabaseSync} from 'node:sqlite';

import {
  DataError,
  describeCause,
  DispatchError,
  EnvironmentError,
} from '../errors.mts';
import {isRole, isTargetKind} from './roles.mts';
import {SCHEMA, SCHEMA_VERSION} from './schema.mts';
import type {
  Claim,
  GraphEdge,
  GraphNode,
  GraphSnapshot,
  Milestone,
  Project,
  ReviewRecord,
} from './types.mts';

/** The outcome of a claim attempt, so the command can report it precisely. */
export type ClaimOutcome =
  | 'claimed' // was free, now ours
  | 'refreshed' // already ours; heartbeat bumped
  | 'reclaimed' // the previous holder's claim was stale; now ours
  | 'held' // a live claim by another agent — we did not take it
  | 'not-available'; // free, but the task is not eligible to be picked up

export interface ClaimResult {
  outcome: ClaimOutcome;
  /** The agent that holds it when the outcome is `held`. */
  heldBy?: string;
}

type SqlValue = string | number | null;

/* eslint-disable @typescript-eslint/require-await --
 * The async signatures are the point of this class. `node:sqlite` is synchronous
 * today; these methods are async so an async driver later is a change behind this
 * facade, not a rewrite of every call site. */

/**
 * The §2.6 durable graph cache: tasks, milestones, their edges, plus the
 * orchestrator's claims and milestone-review records.
 *
 * Every method is async even though `node:sqlite` is synchronous — see above.
 */
export class GraphStore {
  readonly #db: DatabaseSync;

  private constructor(db: DatabaseSync) {
    this.#db = db;
  }

  static async open(path: string): Promise<GraphStore> {
    if (path !== ':memory:') {
      try {
        await mkdir(dirname(path), {recursive: true});
      } catch (cause) {
        throw new EnvironmentError(
          `cannot create the directory for the graph database at ${path}: ${describeCause(cause)}`,
          {hint: 'check the path is writable, or point --db somewhere else.'}
        );
      }
    }

    try {
      const db = new DatabaseSync(path);
      db.exec('PRAGMA journal_mode = WAL');
      // Several agents share one graph. Without a busy timeout SQLite fails the
      // moment it meets a concurrent writer, turning routine contention into a
      // hard error.
      db.exec('PRAGMA busy_timeout = 5000');
      db.exec(SCHEMA);

      const store = new GraphStore(db);
      store.#run(
        'INSERT INTO meta (key, value) VALUES (?, ?) ' +
          'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        ['schema_version', String(SCHEMA_VERSION)]
      );
      return store;
    } catch (cause) {
      if (cause instanceof DispatchError) throw cause;
      throw new EnvironmentError(
        `cannot open the graph database at ${path}: ${describeCause(cause)}`,
        {
          hint: 'check the file is a readable, writable SQLite database and the disk is not full. If it is locked, another dispatch command is mid-write — retry shortly. Deleting the file forces a rebuild.',
        }
      );
    }
  }

  async close(): Promise<void> {
    this.#db.close();
  }

  async upsertProject(project: Project): Promise<void> {
    this.#run(
      'INSERT INTO project (id, name) VALUES (?, ?) ' +
        'ON CONFLICT(id) DO UPDATE SET name = excluded.name',
      [project.id, project.name]
    );
  }

  async removeProject(id: string): Promise<boolean> {
    return this.#run('DELETE FROM project WHERE id = ?', [id]) > 0;
  }

  async upsertTask(task: GraphNode): Promise<void> {
    this.#requireDistinctKind(task.id, 'task', 'milestone');
    this.#run(
      `INSERT INTO task (
         id, project, url, title, role, milestone, target_kind,
         human_interactive, injected, priority, branch_hint, labels, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         project = excluded.project, url = excluded.url, title = excluded.title,
         role = excluded.role, milestone = excluded.milestone,
         target_kind = excluded.target_kind,
         human_interactive = excluded.human_interactive,
         injected = excluded.injected, priority = excluded.priority,
         branch_hint = excluded.branch_hint, labels = excluded.labels,
         updated_at = excluded.updated_at`,
      [
        task.id,
        task.project,
        task.url,
        task.title,
        task.role,
        task.milestone,
        task.targetKind,
        task.humanInteractive ? 1 : 0,
        task.injected ? 1 : 0,
        task.priority,
        task.branchHint,
        JSON.stringify(task.labels),
        task.updatedAt,
      ]
    );
  }

  /** Remove a task, every edge that touched it, and any claim on it. */
  async removeTask(id: string): Promise<boolean> {
    return this.#transaction(() => {
      const removed = this.#run('DELETE FROM task WHERE id = ?', [id]) > 0;
      this.#run('DELETE FROM edge WHERE blocker = ? OR blocked = ?', [id, id]);
      this.#run('DELETE FROM claim WHERE id = ?', [id]);
      return removed;
    });
  }

  async upsertMilestone(milestone: Milestone): Promise<void> {
    this.#requireDistinctKind(milestone.id, 'milestone', 'task');
    this.#run(
      'INSERT INTO milestone (id, project, name) VALUES (?, ?, ?) ' +
        'ON CONFLICT(id) DO UPDATE SET project = excluded.project, name = excluded.name',
      [milestone.id, milestone.project, milestone.name]
    );
  }

  async removeMilestone(id: string): Promise<boolean> {
    return this.#transaction(() => {
      const removed = this.#run('DELETE FROM milestone WHERE id = ?', [id]) > 0;
      this.#run('DELETE FROM edge WHERE blocker = ? OR blocked = ?', [id, id]);
      return removed;
    });
  }

  /** Add one dependency edge. Returns false if it was already present. */
  async addEdge(blocker: string, blocked: string): Promise<boolean> {
    return (
      this.#run(
        'INSERT INTO edge (blocker, blocked) VALUES (?, ?) ON CONFLICT DO NOTHING',
        [blocker, blocked]
      ) > 0
    );
  }

  async removeEdge(blocker: string, blocked: string): Promise<boolean> {
    return (
      this.#run('DELETE FROM edge WHERE blocker = ? AND blocked = ?', [
        blocker,
        blocked,
      ]) > 0
    );
  }

  /**
   * Replace every edge in one direction of a node with the given set — the
   * primitive that lets a re-fetch declare "these are now exactly my blockers"
   * (or blocked) in one call, atomically.
   */
  async setEdges(
    node: string,
    direction: 'blockers' | 'blocks',
    others: readonly string[]
  ): Promise<void> {
    this.#transaction(() => {
      if (direction === 'blockers') {
        this.#run('DELETE FROM edge WHERE blocked = ?', [node]);
        for (const blocker of others) this.#insertEdge(blocker, node);
      } else {
        this.#run('DELETE FROM edge WHERE blocker = ?', [node]);
        for (const blocked of others) this.#insertEdge(node, blocked);
      }
    });
  }

  #insertEdge(blocker: string, blocked: string): void {
    this.#run(
      'INSERT INTO edge (blocker, blocked) VALUES (?, ?) ON CONFLICT DO NOTHING',
      [blocker, blocked]
    );
  }

  /** Wipe the graph. Keeps claims, reviews, and cursors — orchestrator state. */
  async reset(): Promise<void> {
    this.#transaction(() => {
      this.#db.exec('DELETE FROM task');
      this.#db.exec('DELETE FROM edge');
      this.#db.exec('DELETE FROM milestone');
      this.#db.exec('DELETE FROM project');
    });
  }

  /**
   * Claim a task for an agent, atomically.
   *
   * `available` is whether the task is eligible for an *initial* claim — passed
   * in because eligibility is a derived fact. A reclaim of a stale claim ignores
   * it: taking over a dead agent's in-progress work is the point.
   */
  async claim(
    id: string,
    agent: string,
    nowMs: number,
    staleAfterMs: number,
    available: boolean
  ): Promise<ClaimResult> {
    return this.#transaction(() =>
      this.#claimLocked(id, agent, nowMs, staleAfterMs, available)
    );
  }

  /**
   * Claim the first eligible task from a rank-ordered candidate list, atomically.
   * A candidate held by a live claim is skipped; the first one taken is returned.
   */
  async claimNext(
    candidates: readonly string[],
    agent: string,
    nowMs: number,
    staleAfterMs: number
  ): Promise<{id: string; outcome: ClaimOutcome} | null> {
    return this.#transaction(() => {
      for (const id of candidates) {
        const result = this.#claimLocked(id, agent, nowMs, staleAfterMs, true);
        if (result.outcome !== 'held') return {id, outcome: result.outcome};
      }
      return null;
    });
  }

  #claimLocked(
    id: string,
    agent: string,
    nowMs: number,
    staleAfterMs: number,
    available: boolean
  ): ClaimResult {
    const existing = this.#readClaim(id);
    const heartbeat = new Date(nowMs).toISOString();
    const write = (): void => {
      this.#run(
        'INSERT INTO claim (id, agent, heartbeat_at) VALUES (?, ?, ?) ' +
          'ON CONFLICT(id) DO UPDATE SET agent = excluded.agent, heartbeat_at = excluded.heartbeat_at',
        [id, agent, heartbeat]
      );
    };

    if (existing === null) {
      if (!available) return {outcome: 'not-available'};
      write();
      return {outcome: 'claimed'};
    }
    if (existing.agent === agent) {
      write();
      return {outcome: 'refreshed'};
    }
    if (isStale(existing, nowMs, staleAfterMs)) {
      write();
      return {outcome: 'reclaimed'};
    }
    return {outcome: 'held', heldBy: existing.agent};
  }

  async heartbeat(id: string, agent: string, nowMs: number): Promise<boolean> {
    return this.#transaction(() => {
      if (this.#readClaim(id)?.agent !== agent) return false;
      this.#run('UPDATE claim SET heartbeat_at = ? WHERE id = ?', [
        new Date(nowMs).toISOString(),
        id,
      ]);
      return true;
    });
  }

  /** Release a claim. Idempotent; refuses to release another agent's claim. */
  async release(
    id: string,
    agent: string
  ): Promise<'released' | 'absent' | 'not-yours'> {
    return this.#transaction(() => {
      const existing = this.#readClaim(id);
      if (existing === null) return 'absent';
      if (existing.agent !== agent) return 'not-yours';
      this.#run('DELETE FROM claim WHERE id = ?', [id]);
      return 'released';
    });
  }

  /**
   * Tasks and milestones share one id space (edges reference either), so an id
   * must not name both — otherwise `partitionEdges` misreads its edges and
   * removing one kind deletes the other's edges. Rejected at write time, where
   * the fix is obvious: rename one, or remove the other first.
   */
  #requireDistinctKind(
    id: string,
    kind: 'task' | 'milestone',
    other: 'task' | 'milestone'
  ): void {
    const clash = this.#db
      .prepare(`SELECT 1 FROM ${other} WHERE id = ?`)
      .get(id);
    if (clash !== undefined) {
      throw new DataError(
        `id "${id}" is already a ${other}; it cannot also be a ${kind}`,
        {
          hint: `tasks and milestones share one id space — give the ${kind} a different id, or remove the ${other} first.`,
        }
      );
    }
  }

  #readClaim(id: string): Claim | null {
    const row = this.#db
      .prepare('SELECT id, agent, heartbeat_at FROM claim WHERE id = ?')
      .get(id);
    if (row === undefined) return null;
    return {
      id: text(row.id) ?? '',
      agent: text(row.agent) ?? '',
      heartbeatAt: text(row.heartbeat_at) ?? '',
    };
  }

  async getCursor(source: string): Promise<string | null> {
    return this.#guard(() => {
      const row = this.#db
        .prepare('SELECT value FROM cursor WHERE source = ?')
        .get(source);
      return row === undefined ? null : (text(row.value) ?? null);
    });
  }

  async setCursor(source: string, value: string): Promise<void> {
    this.#run(
      'INSERT INTO cursor (source, value) VALUES (?, ?) ' +
        'ON CONFLICT(source) DO UPDATE SET value = excluded.value',
      [source, value]
    );
  }

  async clearCursor(source: string): Promise<boolean> {
    return this.#run('DELETE FROM cursor WHERE source = ?', [source]) > 0;
  }

  /**
   * Record a milestone review against the member set it reviewed. An older record
   * for the same milestone is replaced: only the current episode matters.
   */
  async recordReview(
    milestone: string,
    fingerprint: string,
    recordedAt: string
  ): Promise<void> {
    this.#run(
      'INSERT INTO review (milestone, fingerprint, recorded_at) VALUES (?, ?, ?) ' +
        'ON CONFLICT(milestone) DO UPDATE SET fingerprint = excluded.fingerprint, ' +
        'recorded_at = excluded.recorded_at',
      [milestone, fingerprint, recordedAt]
    );
  }

  async snapshot(): Promise<GraphSnapshot> {
    return this.#guard(() => {
      const cursors: Record<string, string> = {};
      for (const row of this.#all(
        'SELECT source, value FROM cursor ORDER BY source'
      )) {
        cursors[text(row.source) ?? ''] = text(row.value) ?? '';
      }

      return {
        projects: this.#all('SELECT id, name FROM project ORDER BY id').map(
          (row): Project => ({
            id: text(row.id) ?? '',
            name: text(row.name) ?? '',
            declared: true,
          })
        ),
        nodes: this.#all('SELECT * FROM task ORDER BY id').map(toTask),
        edges: this.#all(
          'SELECT blocker, blocked FROM edge ORDER BY blocker, blocked'
        ).map((row): GraphEdge => ({
          blocker: text(row.blocker) ?? '',
          blocked: text(row.blocked) ?? '',
        })),
        milestones: this.#all(
          'SELECT id, project, name FROM milestone ORDER BY project, id'
        ).map((row): Milestone => ({
          id: text(row.id) ?? '',
          project: text(row.project) ?? '',
          name: text(row.name) ?? '',
        })),
        claims: this.#all(
          'SELECT id, agent, heartbeat_at FROM claim ORDER BY id'
        ).map((row): Claim => ({
          id: text(row.id) ?? '',
          agent: text(row.agent) ?? '',
          heartbeatAt: text(row.heartbeat_at) ?? '',
        })),
        reviews: this.#all(
          'SELECT milestone, fingerprint, recorded_at FROM review ORDER BY milestone'
        ).map((row): ReviewRecord => ({
          milestone: text(row.milestone) ?? '',
          fingerprint: text(row.fingerprint) ?? '',
          recordedAt: text(row.recorded_at) ?? '',
        })),
        cursors,
      };
    });
  }

  #transaction<T>(body: () => T): T {
    return this.#guard(() => {
      this.#db.exec('BEGIN');
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
  #guard<T>(body: () => T): T {
    try {
      return body();
    } catch (cause) {
      if (cause instanceof DispatchError) throw cause;
      throw new EnvironmentError(
        `the graph database rejected an operation: ${describeCause(cause)}`,
        {
          hint: 'if the database is locked, another dispatch command is mid-write — retry shortly. Otherwise check the file is a writable SQLite database and the disk is not full.',
        }
      );
    }
  }

  #run(sql: string, params: SqlValue[]): number {
    return this.#guard(() =>
      Number(this.#db.prepare(sql).run(...params).changes)
    );
  }

  #all(sql: string): Record<string, unknown>[] {
    return this.#db.prepare(sql).all();
  }
}

/* eslint-enable @typescript-eslint/require-await --
 * End of the async facade; the helpers below are plain synchronous functions. */

function isStale(claim: Claim, nowMs: number, staleAfterMs: number): boolean {
  const heartbeat = Date.parse(claim.heartbeatAt);
  if (Number.isNaN(heartbeat)) return false;
  return nowMs - heartbeat > staleAfterMs;
}

function toTask(row: Record<string, unknown>): GraphNode {
  const role = text(row.role) ?? '';
  const targetKind = text(row.target_kind) ?? '';
  const rawLabels: unknown = JSON.parse(text(row.labels) ?? '[]');

  return {
    id: text(row.id) ?? '',
    project: text(row.project) ?? '',
    url: text(row.url) ?? '',
    title: text(row.title) ?? '',
    // Validated on the way in; an invalid value on the way out means a hand-edited
    // database, and falling back beats crashing the orchestrator's tick.
    role: isRole(role) ? role : 'backlog',
    milestone: text(row.milestone),
    targetKind: isTargetKind(targetKind) ? targetKind : 'pr',
    humanInteractive: row.human_interactive === 1,
    injected: row.injected === 1,
    priority: typeof row.priority === 'number' ? row.priority : null,
    branchHint: text(row.branch_hint),
    labels: Array.isArray(rawLabels)
      ? rawLabels.filter((label): label is string => typeof label === 'string')
      : [],
    updatedAt: text(row.updated_at),
  };
}

/** SQLite hands values back as `string | number | bigint | null | Uint8Array`. */
function text(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint')
    return String(value);
  return null;
}
