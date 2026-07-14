import {mkdir} from 'node:fs/promises';
import {dirname} from 'node:path';
import {DatabaseSync} from 'node:sqlite';

import {describeCause, DispatchError, EnvironmentError} from '../errors.mts';
import {analyzeBlocking} from './blocking.mts';
import {computeMilestoneStates} from './milestones.mts';
import {
  isExclusionKind,
  isRole,
  isTargetKind,
  type ExclusionKind,
} from './roles.mts';
import {SCHEMA, SCHEMA_VERSION} from './schema.mts';
import type {
  Exclusion,
  GraphEdge,
  GraphNode,
  GraphSnapshot,
  Milestone,
  Project,
  ReviewRecord,
} from './types.mts';

/** One fetch's worth of graph, normalized by an adapter. */
export interface GraphDelta {
  projects: Project[];
  milestones: Milestone[];
  nodes: IngestNode[];
  cursors: Record<string, string>;
}

/**
 * A node as it arrives from an adapter.
 *
 * `blocks` / `blockedBy` are *authoritative for this node in that direction*: if
 * present they replace the node's edges in that direction. Absent means "this
 * fetch says nothing about that direction" — the existing edges stand. That
 * distinction is what lets a delta both add and remove a dependency without the
 * adapter having to send the whole graph.
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
  /** Reviews invalidated because their milestone stopped being ready. */
  reviewsDropped: number;
  projects: number;
  milestones: number;
}

type SqlValue = string | number | null;

/* eslint-disable @typescript-eslint/require-await --
 * The async signatures below are the point of this class, not an oversight.
 * `node:sqlite` is synchronous today; these methods are async so that swapping in
 * an async driver later is a change behind this facade rather than a rewrite of
 * every call site. The rule cannot see that intent. */

/**
 * The §2.6 durable graph cache.
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
      // Several agents share one graph — an orchestrator tick can land while a
      // producer is mid-ingest. Without a busy timeout, SQLite fails the moment
      // it meets a writer, turning routine contention into a hard error.
      db.exec('PRAGMA busy_timeout = 5000');
      db.exec(SCHEMA);

      const store = new GraphStore(db);
      // Inside the try, because this is the first WRITE: it is where a read-only
      // file or a locked database actually surfaces.
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
          hint: 'check the file is a readable, writable SQLite database and the disk is not full. If it is locked, another dispatch command is mid-write — retry shortly. Deleting the file forces a rebuild; a full sync reconstructs it.',
        }
      );
    }
  }

  async close(): Promise<void> {
    this.#db.close();
  }

  /**
   * Apply one fetch to the cache in a single transaction, so a crash mid-write
   * can never leave a half-merged graph behind (§2.6 durable graph cache).
   *
   * A full sync replaces the graph outright — it is the recovery path, and has to
   * drop tickets that have since left the tracker. A delta merges. Either way the
   * orchestrator's own bookkeeping (exclusions, recorded reviews) survives: it is
   * not the producer's to overwrite.
   */
  async applyDelta(
    delta: GraphDelta,
    options: {full?: boolean} = {}
  ): Promise<IngestResult> {
    return this.#transaction(() => {
      if (options.full === true) {
        this.#db.exec('DELETE FROM node');
        this.#db.exec('DELETE FROM edge');
        this.#db.exec('DELETE FROM milestone');
        this.#db.exec('DELETE FROM project');
      }

      for (const project of delta.projects) {
        this.#run(
          'INSERT INTO project (id, name) VALUES (?, ?) ' +
            'ON CONFLICT(id) DO UPDATE SET name = excluded.name',
          [project.id, project.name]
        );
      }

      for (const milestone of delta.milestones) {
        this.#run(
          'INSERT INTO milestone (id, project, name, sort_order) VALUES (?, ?, ?, ?) ' +
            'ON CONFLICT(id) DO UPDATE SET project = excluded.project, ' +
            'name = excluded.name, sort_order = excluded.sort_order',
          [milestone.id, milestone.project, milestone.name, milestone.sortOrder]
        );
      }

      let nodesUpserted = 0;
      let nodesDeleted = 0;

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
          ]
        );
        nodesUpserted += 1;
      }

      // Edge rewrites happen in two passes. A node's declared edge set is
      // authoritative for its own direction, and two nodes in one payload
      // routinely declare the same edge (A says it blocks B; B says it is blocked
      // by A). Deleting per node as we went would let A's delete wipe the edge B
      // had just inserted, so every delete lands before any insert.
      const live = delta.nodes.filter((node) => node.deleted !== true);

      for (const node of live) {
        if (node.blockedBy !== undefined) {
          this.#run('DELETE FROM edge WHERE blocked = ?', [node.id]);
        }
        if (node.blocks !== undefined) {
          this.#run('DELETE FROM edge WHERE blocker = ?', [node.id]);
        }
      }

      // Count the rows actually written, not the insert attempts: both ends of an
      // edge routinely declare it, and reporting that as two edges misleads
      // whoever reads the log.
      let edgesWritten = 0;

      // A ticket deleted by this same delta is gone, and an edge naming it must
      // not come back. Its neighbours still carry it (their fetch saw it before
      // it was deleted), so without this the neighbour's edge list resurrects the
      // edge the delete just removed, and the graph holds a dependency on a
      // ticket it does not have — which reads as an unresolved blocker and holds
      // real work back forever.
      const deletedIds = new Set(
        delta.nodes
          .filter((node) => node.deleted === true)
          .map((node) => node.id)
      );

      const insertEdge = (blocker: string, blocked: string): void => {
        if (deletedIds.has(blocker) || deletedIds.has(blocked)) return;
        edgesWritten += this.#run(
          'INSERT INTO edge (blocker, blocked) VALUES (?, ?) ON CONFLICT DO NOTHING',
          [blocker, blocked]
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
          [source, value]
        );
      }

      return {
        nodesUpserted,
        nodesDeleted,
        edgesWritten,
        reviewsDropped: this.#pruneStaleReviews(),
        projects: delta.projects.length,
        milestones: delta.milestones.length,
      };
    });
  }

  /**
   * Drop the review record of any milestone that is no longer ready for review.
   *
   * A recorded review belongs to one ready-for-review episode (§2.6). The moment
   * the milestone regains open work — a review filed follow-up tickets into it,
   * or a member was reopened — that episode is over, and the old record must not
   * survive to satisfy the gate when the milestone completes again. Pinning the
   * record to a fingerprint of the member ids does not cover this on its own:
   * reopening and re-verifying a member leaves the id set identical.
   *
   * Runs inside the ingest transaction, so the record and the graph it describes
   * can never disagree.
   */
  #pruneStaleReviews(): number {
    const reviews = this.#readReviews();
    if (reviews.length === 0) return 0;

    const nodes = this.#readNodes();
    const analysis = analyzeBlocking(nodes, this.#readEdges());
    const states = computeMilestoneStates(
      nodes,
      this.#readMilestones(),
      reviews,
      analysis
    );

    let dropped = 0;
    for (const review of reviews) {
      // A review of a milestone the graph no longer holds is stale too: nothing
      // can vouch that the work it covered is still done.
      if (states.get(review.milestone)?.readyForReview === true) continue;
      dropped += this.#run('DELETE FROM review WHERE milestone = ?', [
        review.milestone,
      ]);
    }

    return dropped;
  }

  async snapshot(): Promise<GraphSnapshot> {
    return this.#guard(() => {
      const cursors: Record<string, string> = {};
      for (const row of this.#all(
        'SELECT source, value FROM cursor ORDER BY source'
      )) {
        cursors[text(row.source) ?? ''] = text(row.value) ?? '';
      }

      // A project a ticket names but that was never fetched is NOT invented here:
      // `derive` infers it and marks it partial, so the inference holds however
      // the snapshot was assembled.
      return {
        projects: this.#all('SELECT id, name FROM project ORDER BY id').map(
          (row): Project => ({
            id: text(row.id) ?? '',
            name: text(row.name) ?? '',
            declared: true,
          })
        ),
        nodes: this.#readNodes(),
        edges: this.#readEdges(),
        milestones: this.#readMilestones(),
        exclusions: this.#readExclusions(),
        reviews: this.#readReviews(),
        cursors,
      };
    });
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

  async addExclusion(id: string, kind: ExclusionKind): Promise<void> {
    this.#run(
      'INSERT INTO exclusion (id, kind) VALUES (?, ?) ' +
        'ON CONFLICT(id) DO UPDATE SET kind = excluded.kind',
      [id, kind]
    );
  }

  async removeExclusion(id: string): Promise<number> {
    return this.#run('DELETE FROM exclusion WHERE id = ?', [id]);
  }

  async listExclusions(): Promise<Exclusion[]> {
    return this.#guard(() => this.#readExclusions());
  }

  /**
   * Record a milestone review against the member set it reviewed. An older record
   * for the same milestone is replaced: only the current episode matters, and
   * keeping the stale one invites an earlier member set that happens to recur to
   * satisfy the gate.
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

  #readNodes(): GraphNode[] {
    return this.#all('SELECT * FROM node ORDER BY id').map(toNode);
  }

  #readEdges(): GraphEdge[] {
    return this.#all(
      'SELECT blocker, blocked FROM edge ORDER BY blocker, blocked'
    ).map((row) => ({
      blocker: text(row.blocker) ?? '',
      blocked: text(row.blocked) ?? '',
    }));
  }

  #readMilestones(): Milestone[] {
    return this.#all(
      'SELECT id, project, name, sort_order FROM milestone ORDER BY project, sort_order'
    ).map((row) => ({
      id: text(row.id) ?? '',
      project: text(row.project) ?? '',
      name: text(row.name) ?? '',
      sortOrder: Number(row.sort_order),
    }));
  }

  #readExclusions(): Exclusion[] {
    return this.#all('SELECT id, kind FROM exclusion ORDER BY id').map(
      (row) => {
        const kind = text(row.kind) ?? '';
        return {
          id: text(row.id) ?? '',
          // Written through `addExclusion`, which only accepts a valid kind. A row
          // that is somehow invalid means a hand-edited database; reading it as
          // in-flight withholds the ticket, which is the safe way to be wrong.
          kind: isExclusionKind(kind) ? kind : 'in-flight',
        };
      }
    );
  }

  #readReviews(): ReviewRecord[] {
    return this.#all(
      'SELECT milestone, fingerprint, recorded_at FROM review ORDER BY milestone'
    ).map((row) => ({
      milestone: text(row.milestone) ?? '',
      fingerprint: text(row.fingerprint) ?? '',
      recordedAt: text(row.recorded_at) ?? '',
    }));
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
          // A failing ROLLBACK must not replace the error that caused it — that
          // error is the one the caller needs to see.
        }
        throw error;
      }
    });
  }

  /**
   * Turn a SQLite failure into an environment error.
   *
   * A locked or unwritable database is a fact about the machine, not a mistake in
   * how the CLI was called. Left unwrapped it surfaces as "a bug in the dispatch
   * CLI", which sends the calling agent off to report a transient lock as a
   * defect instead of retrying.
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
    return Number(this.#db.prepare(sql).run(...params).changes);
  }

  #all(sql: string): Record<string, unknown>[] {
    return this.#db.prepare(sql).all();
  }
}

/* eslint-enable @typescript-eslint/require-await --
 * End of the async facade; the helpers below are plain synchronous functions and
 * should be held to the rule. */

function toNode(row: Record<string, unknown>): GraphNode {
  const role = text(row.role) ?? '';
  const targetKind = text(row.target_kind) ?? '';
  const rawLabels: unknown = JSON.parse(text(row.labels) ?? '[]');

  return {
    id: text(row.id) ?? '',
    project: text(row.project) ?? '',
    url: text(row.url) ?? '',
    title: text(row.title) ?? '',
    // Role and target kind were validated on the way in. A value that is somehow
    // invalid on the way out means a hand-edited database, and falling back beats
    // crashing the orchestrator's tick.
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
