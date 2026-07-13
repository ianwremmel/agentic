import { DatabaseSync } from 'node:sqlite';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import { DispatchError, EnvironmentError } from '../errors.mts';
import { analyzeBlocking } from '../graph/blocking.mts';
import { findPermanentlyStuck } from '../graph/derive.mts';
import { computeMilestoneStates } from '../graph/milestones.mts';
import type {
  Exclusion,
  GraphEdge,
  GraphNode,
  GraphSnapshot,
  Milestone,
  Project,
  ReviewRecord,
} from '../graph/types.mts';
import { isExclusionKind, isRole, isTargetKind } from '../roles.mts';
import { SCHEMA, SCHEMA_VERSION } from './schema.mts';

/** One fetch's worth of graph, normalized by an adapter. */
export interface GraphDelta {
  projects: Project[];
  milestones: Milestone[];
  nodes: IngestNode[];
  cursors: Record<string, string>;
}

/**
 * A node as it arrives from an adapter. `blocks` / `blockedBy` are *authoritative
 * for that node in that direction*: if present, they replace the node's edges in
 * that direction. Absent means "this fetch says nothing about that direction" —
 * existing edges stand.
 */
export interface IngestNode extends GraphNode {
  blocks?: string[];
  blockedBy?: string[];
  deleted?: boolean;
}

export interface IngestResult {
  nodesUpserted: number;
  nodesDeleted: number;
  edgesWritten: number;
  /** Review records invalidated because their milestone stopped being ready. */
  reviewsDropped: number;
  projects: number;
  milestones: number;
}

type SqlValue = string | number | null;

/* eslint-disable @typescript-eslint/require-await --
 * The async signatures below are the point of this class, not an oversight.
 * `node:sqlite` is synchronous today; the methods are async so that swapping in
 * an async driver later is a change behind this facade rather than a rewrite of
 * every call site. The rule cannot see that intent. */

/**
 * The durable graph cache.
 *
 * Every method is async even though `node:sqlite` is synchronous — see the note
 * above.
 */
export class GraphStore {
  readonly #db: DatabaseSync;

  private constructor(db: DatabaseSync) {
    this.#db = db;
  }

  static async open(path: string): Promise<GraphStore> {
    if (path !== ':memory:') {
      try {
        await mkdir(dirname(path), { recursive: true });
      } catch (cause) {
        throw new EnvironmentError(
          `cannot create the directory for the graph database at ${path}: ${describe(cause)}`,
          'check that the path is writable, or point --db somewhere else.',
        );
      }
    }

    let store: GraphStore;
    try {
      const db = new DatabaseSync(path);
      db.exec('PRAGMA journal_mode = WAL');
      db.exec('PRAGMA foreign_keys = ON');
      // Several agents share one graph — an orchestrator tick can land while a
      // producer is mid-ingest. Without a busy timeout SQLite fails the moment
      // it meets a writer, turning routine contention into a hard error.
      db.exec('PRAGMA busy_timeout = 5000');
      db.exec(SCHEMA);

      store = new GraphStore(db);
      // Inside the try: this is the first WRITE, so it is where a read-only file
      // or a locked database actually surfaces.
      store.#setMeta('schema_version', String(SCHEMA_VERSION));
    } catch (cause) {
      throw new EnvironmentError(
        `cannot open the graph database at ${path}: ${describe(cause)}`,
        'check the file is a readable, writable SQLite database and the disk is not full. If it is locked, another dispatch command is mid-write — retry shortly. Delete the file to force a rebuild; a full sync reconstructs it.',
      );
    }

    return store;
  }

  async close(): Promise<void> {
    this.#db.close();
  }

  /**
   * Apply one fetch to the cache, in a single transaction, so a crash mid-write
   * can never leave a half-merged graph behind.
   *
   * A full sync replaces the graph outright (it is the recovery path, and must
   * drop tickets that have since disappeared from the tracker). A delta merges.
   * Either way the orchestrator's own bookkeeping — exclusions and recorded
   * reviews — survives: it is not the producer's to overwrite.
   */
  async applyDelta(
    delta: GraphDelta,
    options: { full?: boolean } = {},
  ): Promise<IngestResult> {
    const full = options.full ?? false;

    return this.#transaction(() => {
      if (full) {
        this.#db.exec('DELETE FROM node');
        this.#db.exec('DELETE FROM edge');
        this.#db.exec('DELETE FROM milestone');
        this.#db.exec('DELETE FROM project');
      }

      for (const project of delta.projects) {
        this.#run(
          'INSERT INTO project (id, name) VALUES (?, ?) ' +
            'ON CONFLICT(id) DO UPDATE SET name = excluded.name',
          [project.id, project.name],
        );
      }

      for (const milestone of delta.milestones) {
        this.#run(
          'INSERT INTO milestone (id, project, name, sort_order) VALUES (?, ?, ?, ?) ' +
            'ON CONFLICT(id) DO UPDATE SET project = excluded.project, ' +
            'name = excluded.name, sort_order = excluded.sort_order',
          [
            milestone.id,
            milestone.project,
            milestone.name,
            milestone.sortOrder,
          ],
        );
      }

      let nodesDeleted = 0;
      let nodesUpserted = 0;

      for (const node of delta.nodes) {
        if (node.deleted === true) {
          this.#run('DELETE FROM node WHERE id = ?', [node.id]);
          this.#run('DELETE FROM edge WHERE blocker = ? OR blocked = ?', [
            node.id,
            node.id,
          ]);
          nodesDeleted += 1;
          continue;
        }

        this.#run(
          `INSERT INTO node (
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
            node.id,
            node.project,
            node.url,
            node.title,
            node.role,
            node.milestone,
            node.targetKind,
            node.humanInteractive ? 1 : 0,
            node.injected ? 1 : 0,
            node.priority,
            node.branchHint,
            JSON.stringify(node.labels),
            node.updatedAt,
          ],
        );
        nodesUpserted += 1;
      }

      // Edge rewrites happen in two passes. A node's declared edge set is
      // authoritative for its own direction, and two nodes in the same payload
      // routinely declare the same edge (A says it blocks B; B says it is
      // blocked by A). Deleting per node as we go would let A's delete wipe the
      // edge B just inserted, so every delete lands before any insert.
      const live = delta.nodes.filter((node) => node.deleted !== true);

      for (const node of live) {
        if (node.blockedBy !== undefined) {
          this.#run('DELETE FROM edge WHERE blocked = ?', [node.id]);
        }
        if (node.blocks !== undefined) {
          this.#run('DELETE FROM edge WHERE blocker = ?', [node.id]);
        }
      }

      // Count rows actually written, not insert attempts. The two nodes of an
      // edge routinely both declare it (A says it blocks B; B says it is blocked
      // by A), and reporting that as two edges misleads whoever reads the log.
      let edgesWritten = 0;
      const insertEdge = (blocker: string, blocked: string): void => {
        edgesWritten += this.#run(
          'INSERT INTO edge (blocker, blocked) VALUES (?, ?) ON CONFLICT DO NOTHING',
          [blocker, blocked],
        );
      };

      for (const node of live) {
        for (const blocker of node.blockedBy ?? [])
          insertEdge(blocker, node.id);
        for (const blocked of node.blocks ?? []) insertEdge(node.id, blocked);
      }

      for (const [source, value] of Object.entries(delta.cursors)) {
        this.#run(
          'INSERT INTO cursor (source, value) VALUES (?, ?) ' +
            'ON CONFLICT(source) DO UPDATE SET value = excluded.value',
          [source, value],
        );
      }

      const reviewsDropped = this.#pruneStaleReviews();

      return {
        nodesUpserted,
        nodesDeleted,
        edgesWritten,
        reviewsDropped,
        projects: delta.projects.length,
        milestones: delta.milestones.length,
      };
    });
  }

  /**
   * Drop the review record of any milestone that is no longer ready for review.
   *
   * A recorded review belongs to one ready-for-review episode. The moment the
   * milestone regains open work — a review filed follow-up tickets into it, or a
   * member was reopened — that episode is over, and the old record must not
   * survive to satisfy the gate when the milestone completes again. Pinning the
   * record to a fingerprint of the member ids is not enough on its own: reopening
   * and re-verifying a member leaves the id set identical.
   *
   * Runs inside the ingest transaction, so the record and the graph it describes
   * can never disagree.
   */
  #pruneStaleReviews(): number {
    const nodes = this.#all('SELECT * FROM node ORDER BY id').map(toNode);
    if (nodes.length === 0) return 0;

    const edges = this.#all('SELECT blocker, blocked FROM edge').map(
      (row): GraphEdge => ({
        blocker: text(row.blocker) ?? '',
        blocked: text(row.blocked) ?? '',
      }),
    );
    const milestones = this.#readMilestones();
    const exclusions = this.#readExclusions();
    const reviews = this.#readReviews();
    if (reviews.length === 0) return 0;

    const analysis = analyzeBlocking(nodes, edges);
    const { permanentIds } = findPermanentlyStuck(nodes, exclusions, analysis);
    const states = computeMilestoneStates(
      nodes,
      milestones,
      reviews,
      analysis,
      permanentIds,
    );

    let dropped = 0;
    for (const review of reviews) {
      const state = states.get(review.milestone);
      if (state !== undefined && state.readyForReview) continue;
      dropped += this.#run('DELETE FROM review WHERE milestone = ?', [
        review.milestone,
      ]);
    }
    return dropped;
  }

  async snapshot(): Promise<GraphSnapshot> {
    return this.#guard(() => {
      const nodes = this.#all('SELECT * FROM node ORDER BY id').map(toNode);
      const edges = this.#all(
        'SELECT blocker, blocked FROM edge ORDER BY blocker, blocked',
      ).map((row): GraphEdge => ({
        blocker: text(row.blocker) ?? '',
        blocked: text(row.blocked) ?? '',
      }));

      const projects = this.#all(
        'SELECT id, name FROM project ORDER BY id',
      ).map((row): Project => ({
        id: text(row.id) ?? '',
        name: text(row.name) ?? '',
        declared: true,
      }));

      const cursors: Record<string, string> = {};
      for (const row of this.#all(
        'SELECT source, value FROM cursor ORDER BY source',
      )) {
        cursors[text(row.source) ?? ''] = text(row.value) ?? '';
      }

      // A project a ticket names but that was never fetched is NOT invented
      // here. `derive` infers it and marks it partial, so the inference holds
      // however the snapshot was assembled.
      return {
        projects,
        nodes,
        edges,
        milestones: this.#readMilestones(),
        exclusions: this.#readExclusions(),
        reviews: this.#readReviews(),
        cursors,
      };
    });
  }

  #readMilestones(): Milestone[] {
    return this.#all(
      'SELECT id, project, name, sort_order FROM milestone ORDER BY project, sort_order',
    ).map((row): Milestone => ({
      id: text(row.id) ?? '',
      project: text(row.project) ?? '',
      name: text(row.name) ?? '',
      sortOrder: Number(row.sort_order),
    }));
  }

  #readExclusions(): Exclusion[] {
    return this.#all('SELECT id, kind FROM exclusion ORDER BY id').map(
      (row): Exclusion => {
        const kind = text(row.kind) ?? '';
        return {
          id: text(row.id) ?? '',
          kind: isExclusionKind(kind) ? kind : 'in-flight',
        };
      },
    );
  }

  #readReviews(): ReviewRecord[] {
    return this.#all(
      'SELECT milestone, fingerprint, recorded_at FROM review',
    ).map((row): ReviewRecord => ({
      milestone: text(row.milestone) ?? '',
      fingerprint: text(row.fingerprint) ?? '',
      recordedAt: text(row.recorded_at) ?? '',
    }));
  }

  async getCursor(source: string): Promise<string | null> {
    return this.#guard(() => {
      const row = this.#db
        .prepare('SELECT value FROM cursor WHERE source = ?')
        .get(source) as Record<string, unknown> | undefined;
      return row === undefined ? null : (text(row.value) ?? null);
    });
  }

  async setCursor(source: string, value: string): Promise<void> {
    this.#run(
      'INSERT INTO cursor (source, value) VALUES (?, ?) ' +
        'ON CONFLICT(source) DO UPDATE SET value = excluded.value',
      [source, value],
    );
  }

  async addExclusion(id: string, kind: string): Promise<void> {
    this.#run(
      'INSERT INTO exclusion (id, kind) VALUES (?, ?) ' +
        'ON CONFLICT(id) DO UPDATE SET kind = excluded.kind',
      [id, kind],
    );
  }

  async removeExclusion(id: string): Promise<void> {
    this.#run('DELETE FROM exclusion WHERE id = ?', [id]);
  }

  async listExclusions(): Promise<Exclusion[]> {
    const snapshot = await this.snapshot();
    return snapshot.exclusions;
  }

  /**
   * Record a milestone review against the member set it reviewed. Older records
   * for the same milestone are dropped: only the current episode matters, and
   * keeping the stale ones invites a fingerprint collision from an earlier
   * member set that happens to recur.
   */
  async recordReview(
    milestone: string,
    fingerprint: string,
    recordedAt: string,
  ): Promise<void> {
    this.#transaction(() => {
      this.#run('DELETE FROM review WHERE milestone = ?', [milestone]);
      this.#run(
        'INSERT INTO review (milestone, fingerprint, recorded_at) VALUES (?, ?, ?)',
        [milestone, fingerprint, recordedAt],
      );
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
          // A failing ROLLBACK must not replace the error that caused it —
          // that error is the one the caller needs to see.
        }
        throw error;
      }
    });
  }

  /**
   * Turn a SQLite failure into an environment error.
   *
   * A locked or unwritable database is a fact about the machine, not a mistake
   * in how the CLI was called. Left unwrapped it surfaces as "internal error —
   * this is a bug in the dispatch CLI", which sends the calling agent off to
   * report a transient lock as a defect instead of retrying.
   */
  #guard<T>(body: () => T): T {
    try {
      return body();
    } catch (cause) {
      if (cause instanceof DispatchError) throw cause;
      throw new EnvironmentError(
        `the graph database rejected an operation: ${describe(cause)}`,
        'if the database is locked, another dispatch command is mid-write — retry shortly. Otherwise check the file is a writable SQLite database and the disk is not full.',
      );
    }
  }

  #run(sql: string, params: SqlValue[]): number {
    return Number(this.#db.prepare(sql).run(...params).changes);
  }

  #all(sql: string): Record<string, unknown>[] {
    return this.#db.prepare(sql).all();
  }

  #setMeta(key: string, value: string): void {
    this.#run(
      'INSERT INTO meta (key, value) VALUES (?, ?) ' +
        'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      [key, value],
    );
  }
}

/* eslint-enable @typescript-eslint/require-await --
 * End of the async-facade class; the helpers below are plain synchronous
 * functions and should be held to the rule. */

function toNode(row: Record<string, unknown>): GraphNode {
  const role = text(row.role) ?? '';
  const targetKind = text(row.target_kind) ?? '';
  const rawLabels: unknown = JSON.parse(text(row.labels) ?? '[]');

  return {
    id: text(row.id) ?? '',
    project: text(row.project) ?? '',
    url: text(row.url) ?? '',
    title: text(row.title) ?? '',
    // The role and target kind were validated on the way in; a value that is
    // somehow invalid on the way out means a hand-edited database, and falling
    // back beats crashing the orchestrator's tick.
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

/** SQLite hands back `string | number | bigint | null | Uint8Array` as unknown. */
function text(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint')
    return String(value);
  return null;
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
