import assert from 'node:assert';

import {Database} from '../db/database.mts';
import {DataError} from '../errors.mts';
import {
  classifiedNodes,
  frontier,
  milestoneStates,
  type DeriveOptions,
} from './queries.mts';
import {isRole, isTargetKind, ROLE_LIST, TARGET_KIND_LIST} from './roles.mts';
import type {Classification, GraphNode, Milestone} from './types.mts';

/** The outcome of a claim attempt, so the command can report it precisely. */
export type ClaimOutcome =
  | 'claimed' // was free, now ours
  | 'refreshed' // already ours; heartbeat bumped
  | 'reclaimed' // the previous holder's claim was stale; now ours
  | 'held' // a live claim by another agent — we did not take it
  | 'not-available' // free, but the task is not eligible to be picked up
  | 'unknown-task'; // no such task in the graph

export interface ClaimResult {
  outcome: ClaimOutcome;
  /** The agent that holds it when the outcome is `held`. */
  heldBy?: string;
  /** The task's classification when the outcome is `not-available`. */
  classification?: Classification;
}

interface NodeRow {
  id: number;
  kind: 'task' | 'milestone' | 'unknown';
}

/* eslint-disable @typescript-eslint/require-await --
 * The async signatures are the point of this class; `node:sqlite` is synchronous
 * today. See `../db/database.mts`. */

/**
 * The durable graph: tasks, milestones, their edges, plus the orchestrator's
 * claims and milestone-review records, over the shared dispatch database.
 *
 * Writes enforce every rule a single write can judge — the schema's CHECK and
 * FOREIGN KEY constraints, id-kind conflicts, task↔milestone edges, cycles,
 * malformed timestamps — so those can never enter the graph through this class.
 * An id named before it is fetched becomes a placeholder node (`kind =
 * 'unknown'`), which is what lets a delta write edges in any order; the
 * placeholder is promoted when its task or milestone row arrives.
 */
export class GraphStore {
  readonly #db: Database;

  private constructor(db: Database) {
    this.#db = db;
  }

  static async open(path: string): Promise<GraphStore> {
    return new GraphStore(await Database.open(path));
  }

  /** The underlying database, for the read-side derivation (`derive.mts`). */
  get database(): Database {
    return this.#db;
  }

  async close(): Promise<void> {
    await this.#db.close();
  }

  async upsertProject(project: {id: string; name: string}): Promise<void> {
    this.#db.run(
      `INSERT INTO project (external_id, name, declared) VALUES (?, ?, 1)
       ON CONFLICT(external_id) DO UPDATE SET name = excluded.name, declared = 1`,
      [project.id, project.name]
    );
  }

  /**
   * Undeclare a project: it stops counting toward terminal and drops from the
   * document unless a task or milestone still names it (then it is partial).
   */
  async removeProject(id: string): Promise<boolean> {
    return (
      this.#db.run(
        'UPDATE project SET declared = 0 WHERE external_id = ? AND declared = 1',
        [id]
      ) > 0
    );
  }

  async upsertTask(task: GraphNode): Promise<void> {
    assert(
      isRole(task.role),
      new DataError(`"${task.role}" is not a protocol role`, {
        hint: `use one of: ${ROLE_LIST}.`,
      })
    );
    assert(
      isTargetKind(task.targetKind),
      new DataError(`"${task.targetKind}" is not a target kind`, {
        hint: `use one of: ${TARGET_KIND_LIST}.`,
      })
    );
    const updatedAtMs = parseInstant(task.updatedAt, '--updated-at');

    await this.#db.transaction(() => {
      const projectId = this.#projectRef(task.project);
      const nodeId = this.#materialize(task.id, 'task');
      const milestoneId =
        task.milestone === null ? null : this.#milestoneRef(task.milestone);

      this.#db.run(
        `INSERT INTO task (
           node_id, project_id, url, title, role, milestone_id, target_kind,
           human_interactive, injected, priority, branch_hint, labels, updated_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(node_id) DO UPDATE SET
           project_id = excluded.project_id, url = excluded.url,
           title = excluded.title, role = excluded.role,
           milestone_id = excluded.milestone_id,
           target_kind = excluded.target_kind,
           human_interactive = excluded.human_interactive,
           injected = excluded.injected, priority = excluded.priority,
           branch_hint = excluded.branch_hint, labels = excluded.labels,
           updated_at_ms = excluded.updated_at_ms`,
        [
          nodeId,
          projectId,
          task.url,
          task.title,
          task.role,
          milestoneId,
          task.targetKind,
          task.humanInteractive ? 1 : 0,
          task.injected ? 1 : 0,
          task.priority,
          task.branchHint,
          JSON.stringify(task.labels),
          updatedAtMs,
        ]
      );
    });
  }

  /** Remove a task, every edge that touched it, and any claim on it. */
  async removeTask(id: string): Promise<boolean> {
    return this.#db.transaction(() => this.#removeNode(id, 'task'));
  }

  async upsertMilestone(milestone: Milestone): Promise<void> {
    await this.#db.transaction(() => {
      const projectId = this.#projectRef(milestone.project);
      const nodeId = this.#materialize(milestone.id, 'milestone');
      this.#db.run(
        `INSERT INTO milestone (node_id, project_id, name) VALUES (?, ?, ?)
         ON CONFLICT(node_id) DO UPDATE SET
           project_id = excluded.project_id, name = excluded.name`,
        [nodeId, projectId, milestone.name]
      );
    });
  }

  /** Remove a milestone, its edges, and any review recorded for it. */
  async removeMilestone(id: string): Promise<boolean> {
    return this.#db.transaction(() => this.#removeNode(id, 'milestone'));
  }

  /**
   * Add one dependency edge, refusing it if it would close a cycle or join a
   * task to a milestone. An endpoint nobody has written yet becomes a
   * placeholder node. Returns false if the edge was already present.
   */
  async addEdge(blocker: string, blocked: string): Promise<boolean> {
    return this.#db.transaction(() => {
      const added = this.#insertEdge(blocker, blocked);
      if (added) this.#rejectIfCycle(blocked);
      return added;
    });
  }

  async removeEdge(blocker: string, blocked: string): Promise<boolean> {
    return (
      this.#db.run(
        `DELETE FROM edge
         WHERE blocker = (SELECT id FROM node WHERE external_id = ?)
           AND blocked = (SELECT id FROM node WHERE external_id = ?)`,
        [blocker, blocked]
      ) > 0
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
    await this.#db.transaction(() => {
      const nodeId = this.#nodeRef(node);
      const column = direction === 'blockers' ? 'blocked' : 'blocker';
      this.#db.run(`DELETE FROM edge WHERE ${column} = ?`, [nodeId]);
      for (const other of others) {
        if (direction === 'blockers') this.#insertEdge(other, node);
        else this.#insertEdge(node, other);
      }
      this.#rejectIfCycle(node);
    });
  }

  /**
   * Wipe the graph for a full rebuild. Claims, recorded reviews, and cursors
   * survive — they are the orchestrator's bookkeeping, not the tracker's to
   * reset. The node rows a claim or review hangs on are kept (demoted to
   * placeholders until the re-sync re-declares them); every other node goes.
   */
  async reset(): Promise<void> {
    await this.#db.transaction(() => {
      this.#db.run('DELETE FROM edge');
      this.#db.run('DELETE FROM task');
      this.#db.run('DELETE FROM milestone');
      this.#db.run('DELETE FROM project');
      this.#db.run(
        `DELETE FROM node
         WHERE id NOT IN (SELECT node_id FROM claim)
           AND id NOT IN (SELECT milestone_id FROM review)`
      );
      this.#db.run("UPDATE node SET kind = 'unknown'");
    });
  }

  /**
   * Claim a task for an agent, atomically. Succeeds when the task is free and
   * available, already held by the caller (a refresh), or held by a stale
   * claim (a takeover — eligibility is ignored, because taking over a dead
   * agent's in-progress work is the point).
   */
  async claim(
    id: string,
    agent: string,
    options: DeriveOptions
  ): Promise<ClaimResult> {
    return this.#db.transaction(() => {
      const node = this.#node(id);
      if (node?.kind !== 'task') return {outcome: 'unknown-task'};
      return this.#claimLocked(node.id, id, agent, options);
    });
  }

  /**
   * Claim the top eligible task off the ranked frontier, atomically. A
   * candidate held by a live claim is skipped; the first one taken is
   * returned, or null when nothing is claimable.
   */
  async claimNext(
    agent: string,
    options: DeriveOptions,
    project?: string
  ): Promise<{id: string; outcome: ClaimOutcome} | null> {
    return this.#db.transaction(() => {
      for (const entry of frontier(this.#db, options, project)) {
        const node = this.#node(entry.node.id);
        if (node === null) continue;
        const result = this.#claimLocked(
          node.id,
          entry.node.id,
          agent,
          options
        );
        if (result.outcome !== 'held')
          return {id: entry.node.id, outcome: result.outcome};
      }
      return null;
    });
  }

  #claimLocked(
    nodeId: number,
    externalId: string,
    agent: string,
    options: DeriveOptions
  ): ClaimResult {
    const nowMs = options.nowMs ?? Date.now();
    const staleAfterMs = options.staleAfterMs ?? Number.MAX_SAFE_INTEGER;
    const existing = this.#db.get(
      'SELECT agent, heartbeat_at_ms FROM claim WHERE node_id = ?',
      [nodeId]
    );
    const write = (): void => {
      this.#db.run(
        `INSERT INTO claim (node_id, agent, heartbeat_at_ms) VALUES (?, ?, ?)
         ON CONFLICT(node_id) DO UPDATE SET
           agent = excluded.agent, heartbeat_at_ms = excluded.heartbeat_at_ms`,
        [nodeId, agent, nowMs]
      );
    };

    if (existing === undefined) {
      const entry = classifiedNodes(this.#db, options).find(
        (candidate) => candidate.node.id === externalId
      );
      if (entry?.classification !== 'available') {
        const result: ClaimResult = {outcome: 'not-available'};
        if (entry !== undefined) result.classification = entry.classification;
        return result;
      }
      write();
      return {outcome: 'claimed'};
    }
    if (existing.agent === agent) {
      write();
      return {outcome: 'refreshed'};
    }
    const heartbeat =
      typeof existing.heartbeat_at_ms === 'number'
        ? existing.heartbeat_at_ms
        : 0;
    if (nowMs - heartbeat > staleAfterMs) {
      write();
      return {outcome: 'reclaimed'};
    }
    return {
      outcome: 'held',
      heldBy: typeof existing.agent === 'string' ? existing.agent : '?',
    };
  }

  async heartbeat(id: string, agent: string, nowMs: number): Promise<boolean> {
    return this.#db.transaction(() => {
      const changed = this.#db.run(
        `UPDATE claim SET heartbeat_at_ms = ?
         WHERE node_id = (SELECT id FROM node WHERE external_id = ?)
           AND agent = ?`,
        [nowMs, id, agent]
      );
      return changed > 0;
    });
  }

  /** Release a claim. Idempotent; refuses to release another agent's claim. */
  async release(
    id: string,
    agent: string
  ): Promise<'released' | 'absent' | 'not-yours'> {
    return this.#db.transaction(() => {
      const existing = this.#db.get(
        `SELECT agent FROM claim
         WHERE node_id = (SELECT id FROM node WHERE external_id = ?)`,
        [id]
      );
      if (existing === undefined) return 'absent';
      if (existing.agent !== agent) return 'not-yours';
      this.#db.run(
        'DELETE FROM claim WHERE node_id = (SELECT id FROM node WHERE external_id = ?)',
        [id]
      );
      return 'released';
    });
  }

  /**
   * Record that a milestone's review ran — the write that opens the milestone
   * gate. Refuses a milestone that is not ready: recording a review of a
   * milestone with open work would open the gate on unfinished work. The
   * record is pinned to the member set it reviewed, so a review that files
   * follow-up tasks into the milestone stops satisfying the gate.
   */
  async recordReview(
    id: string,
    recordedAtMs: number,
    options: DeriveOptions
  ): Promise<{members: number}> {
    return this.#db.transaction(() => {
      const states = milestoneStates(this.#db, options);
      const state = states.find((candidate) => candidate.id === id);
      assert(
        state !== undefined,
        new DataError(`no milestone "${id}" in the graph`, {
          hint:
            states.length === 0
              ? 'the graph holds no milestones — add them with `dispatch graph milestone set`.'
              : `known milestones: ${states.map((entry) => entry.id).join(', ')}.`,
        })
      );
      assert(
        state.readyForReview,
        new DataError(
          `milestone "${id}" is not ready for review: ${String(state.openCount)} of ${String(state.memberCount)} tasks are still open`,
          {
            hint: 'a milestone is ready only when every task in it is verified or canceled and none of their dependencies is unresolved.',
          }
        )
      );

      const nodeId = this.#nodeRef(id);
      this.#db.run('DELETE FROM review WHERE milestone_id = ?', [nodeId]);
      this.#db.run(
        'INSERT INTO review (milestone_id, recorded_at_ms) VALUES (?, ?)',
        [nodeId, recordedAtMs]
      );
      this.#db.run(
        `INSERT INTO review_member (milestone_id, member_external_id)
         SELECT ?, n.external_id
         FROM task t JOIN node n ON n.id = t.node_id
         WHERE t.milestone_id = ?`,
        [nodeId, nodeId]
      );
      return {members: state.memberCount};
    });
  }

  async getCursor(source: string): Promise<string | null> {
    const row = this.#db.get('SELECT value FROM cursor WHERE source = ?', [
      source,
    ]);
    return row === undefined ? null : String(row.value);
  }

  async setCursor(source: string, value: string): Promise<void> {
    this.#db.run(
      `INSERT INTO cursor (source, value) VALUES (?, ?)
       ON CONFLICT(source) DO UPDATE SET value = excluded.value`,
      [source, value]
    );
  }

  async clearCursor(source: string): Promise<boolean> {
    return this.#db.run('DELETE FROM cursor WHERE source = ?', [source]) > 0;
  }

  #node(externalId: string): NodeRow | null {
    const row = this.#db.get(
      'SELECT id, kind FROM node WHERE external_id = ?',
      [externalId]
    );
    if (row === undefined) return null;
    return {id: Number(row.id), kind: row.kind as NodeRow['kind']};
  }

  /** The node for an id, creating a placeholder when nobody has written it. */
  #nodeRef(externalId: string): number {
    const existing = this.#node(externalId);
    if (existing !== null) return existing.id;
    this.#db.run("INSERT INTO node (external_id, kind) VALUES (?, 'unknown')", [
      externalId,
    ]);
    const created = this.#node(externalId);
    assert(created !== null, 'a node just inserted must exist');
    return created.id;
  }

  /**
   * The node for a task/milestone being written: created with its kind, or
   * promoted from a placeholder — after checking the promotion keeps every
   * edge and milestone reference legal. An id already holding the *other* kind
   * is a conflict: tasks and milestones share one id space.
   */
  #materialize(externalId: string, kind: 'task' | 'milestone'): number {
    const existing = this.#node(externalId);
    if (existing === null) {
      this.#db.run('INSERT INTO node (external_id, kind) VALUES (?, ?)', [
        externalId,
        kind,
      ]);
      const created = this.#node(externalId);
      assert(created !== null, 'a node just inserted must exist');
      return created.id;
    }
    if (existing.kind === kind) return existing.id;

    assert(
      existing.kind === 'unknown',
      new DataError(
        `id "${externalId}" is already a ${existing.kind}; it cannot also be a ${kind}`,
        {
          hint: `tasks and milestones share one id space — give the ${kind} a different id, or remove the ${existing.kind} first.`,
        }
      )
    );

    this.#rejectMixedEdges(existing.id, externalId, kind);
    if (kind === 'task') this.#rejectMilestoneRefs(existing.id, externalId);
    this.#db.run('UPDATE node SET kind = ? WHERE id = ?', [kind, existing.id]);
    return existing.id;
  }

  /**
   * The milestone a task names. An id nobody has written stays a placeholder —
   * the document reports it as an unknown milestone until it is declared — but
   * an id already known to be a task is a data error, caught here where the
   * fix is obvious.
   */
  #milestoneRef(externalId: string): number {
    const existing = this.#node(externalId);
    if (existing === null) return this.#nodeRef(externalId);
    assert(
      existing.kind !== 'task',
      new DataError(
        `"${externalId}" is a task; a task cannot be another task's milestone`,
        {
          hint: 'point --milestone at a milestone id, or declare the milestone first with `dispatch graph milestone set`.',
        }
      )
    );
    return existing.id;
  }

  #removeNode(externalId: string, kind: 'task' | 'milestone'): boolean {
    const existing = this.#node(externalId);
    if (existing?.kind !== kind) return false;
    // The FKs cascade: the satellite row, every edge touching the node, its
    // claim, and (for a milestone) its review all go with it.
    this.#db.run('DELETE FROM node WHERE id = ?', [existing.id]);
    return true;
  }

  #insertEdge(blocker: string, blocked: string): boolean {
    assert(
      blocker !== blocked,
      new DataError(`a node cannot block itself (${blocker})`, {
        hint: 'a self-edge is an illegal one-node cycle.',
      })
    );
    const blockerId = this.#nodeRef(blocker);
    const blockedId = this.#nodeRef(blocked);
    this.#rejectTaskMilestoneEdge(
      {id: blockerId, externalId: blocker},
      {id: blockedId, externalId: blocked}
    );
    return (
      this.#db.run(
        'INSERT INTO edge (blocker, blocked) VALUES (?, ?) ON CONFLICT DO NOTHING',
        [blockerId, blockedId]
      ) > 0
    );
  }

  #rejectTaskMilestoneEdge(
    a: {id: number; externalId: string},
    b: {id: number; externalId: string}
  ): void {
    const row = this.#db.get(
      `SELECT na.kind AS a_kind, nb.kind AS b_kind
       FROM node na, node nb WHERE na.id = ? AND nb.id = ?`,
      [a.id, b.id]
    );
    const kinds = new Set([row?.a_kind, row?.b_kind]);
    assert(
      !(kinds.has('task') && kinds.has('milestone')),
      new DataError(
        `an edge cannot join a task and a milestone (${a.externalId} -> ${b.externalId})`,
        {
          hint: 'sequence milestones with milestone-to-milestone edges, and attach a task to a milestone with `task set --milestone` instead.',
        }
      )
    );
  }

  /**
   * A placeholder being promoted must not turn an existing edge into a
   * task↔milestone edge — the write that would have created one directly is
   * refused, so the promotion is held to the same rule.
   */
  #rejectMixedEdges(
    nodeId: number,
    externalId: string,
    kind: 'task' | 'milestone'
  ): void {
    const opposite = kind === 'task' ? 'milestone' : 'task';
    const partner = this.#db.get(
      `SELECT other.external_id AS id
       FROM edge e
       JOIN node other
         ON other.id = CASE WHEN e.blocker = ? THEN e.blocked ELSE e.blocker END
       WHERE (e.blocker = ? OR e.blocked = ?) AND other.kind = ?
       LIMIT 1`,
      [nodeId, nodeId, nodeId, opposite]
    );
    assert(
      partner === undefined,
      new DataError(
        `"${externalId}" cannot become a ${kind}: it has an edge with the ${opposite} "${String(partner?.id)}", and an edge cannot join a task and a milestone`,
        {
          hint: 'remove the edge first, or fix whichever id is wrong.',
        }
      )
    );
  }

  /** A node tasks name as their milestone cannot be promoted to a task. */
  #rejectMilestoneRefs(nodeId: number, externalId: string): void {
    const referrer = this.#db.get(
      `SELECT n.external_id AS id
       FROM task t JOIN node n ON n.id = t.node_id
       WHERE t.milestone_id = ? LIMIT 1`,
      [nodeId]
    );
    assert(
      referrer === undefined,
      new DataError(
        `"${externalId}" cannot become a task: task "${String(referrer?.id)}" names it as its milestone`,
        {
          hint: 'declare it with `dispatch graph milestone set`, or fix the referring task first.',
        }
      )
    );
  }

  /**
   * Throw (rolling back the enclosing transaction, so the edge is never
   * created) if `node` now sits on a dependency cycle. A cycle can only have
   * appeared because of an edge just written through `node`, so checking it
   * alone is enough. Walked by a recursive CTE over the blocker→blocked edges.
   */
  #rejectIfCycle(externalId: string): void {
    const onCycle = this.#db.get(
      `WITH RECURSIVE reach(id) AS (
         SELECT blocked FROM edge
         WHERE blocker = (SELECT id FROM node WHERE external_id = ?)
         UNION
         SELECT e.blocked FROM edge e JOIN reach r ON e.blocker = r.id
       )
       SELECT 1 FROM reach
       WHERE id = (SELECT id FROM node WHERE external_id = ?) LIMIT 1`,
      [externalId, externalId]
    );

    assert(
      onCycle === undefined,
      new DataError(
        `that edge would create a dependency cycle through ${externalId}`,
        {
          hint: 'a dependency cycle is illegal. Remove the opposing edge first, or fix the dependency direction.',
        }
      )
    );
  }

  #projectRef(externalId: string): number {
    this.#db.run(
      'INSERT INTO project (external_id, name, declared) VALUES (?, ?, 0) ON CONFLICT DO NOTHING',
      [externalId, externalId]
    );
    const row = this.#db.get('SELECT id FROM project WHERE external_id = ?', [
      externalId,
    ]);
    assert(row !== undefined, 'a project just inserted must exist');
    return Number(row.id);
  }
}

/* eslint-enable @typescript-eslint/require-await */

/** Parse an RFC 3339 instant to epoch ms, or reject it where the fix is easy. */
function parseInstant(value: string | null, flag: string): number | null {
  if (value === null) return null;
  const ms = Date.parse(value);
  assert(
    !Number.isNaN(ms),
    new DataError(`${flag} is not a timestamp: "${value}"`, {
      hint: `pass an RFC 3339 instant (e.g. 2026-07-15T12:00:00Z), or omit ${flag}.`,
    })
  );
  return ms;
}
