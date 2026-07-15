import type {Database, Row, SqlValue} from '../db/database.mts';
import {
  DEFAULT_PARKED_ROLES,
  GROUP_OF,
  isRole,
  isTargetKind,
  RESOLVED_ROLES,
  ROLES,
  type Role,
} from './roles.mts';
import type {
  Anomaly,
  Classification,
  ClassifiedNode,
  MilestoneState,
} from './types.mts';

export interface DeriveOptions {
  parkedRoles?: readonly Role[];
  /** Now, in epoch ms — used to judge claim staleness. Defaults to `Date.now()`. */
  nowMs?: number;
  /** A claim older than this (ms) is dead and no longer holds its task. */
  staleAfterMs?: number;
}

const quoted = (values: readonly string[]): string =>
  values.map((value) => `'${value}'`).join(', ');

const RESOLVED_SQL = quoted([...RESOLVED_ROLES]);
const STARTED_SQL = quoted(
  ROLES.filter((role) => GROUP_OF[role] === 'started')
);

/**
 * The graph reasoning, as one CTE pipeline over the store's tables. Every entry
 * query below shares this prefix, so blocking, ranking, and gating always agree.
 *
 * Parameters, in order: now (epoch ms), claim staleness (ms), parked roles (a
 * JSON array), and an optional project filter (external id, or NULL for all).
 *
 * The pieces:
 *
 * - `blocking_edge` / `seq_edge` — an edge between two declared milestones is
 *   sequencing; every other edge (including one touching a placeholder)
 *   participates in task blocking, which is the safe default for an endpoint
 *   nobody has fetched yet.
 * - `anc` — the transitive blocker closure. The recursion continues only
 *   through an *unresolved* ancestor: a `verified`/`canceled` ticket does not
 *   block, and the tickets behind it are no longer on a live path to its
 *   dependents (cancellation releases downstream work). A placeholder has no
 *   role, so it reads as unresolved and holds its dependents.
 * - `descendant`/`fanout` — transitive descendant counts over the whole graph,
 *   resolved or not: how much work a ticket gates, a ranking signal rather
 *   than a blocking one.
 * - `review_valid` — a recorded review counts only while it covers exactly the
 *   current member set and no member moved after it was recorded.
 * - `milestone_state`/`gate` — a milestone is ready when every member is
 *   settled and none carries an unresolved dependency; a task is gated while
 *   any milestone transitively blocking its own milestone is not yet reviewed.
 *   Readiness never looks at sequencing, which keeps milestone gating acyclic.
 * - `classified` — the §2.3-derived classification, highest precedence first:
 *   resolved → in-flight (started role, or a live claim) → dormant (backlog) →
 *   blocked → human-blocked → available.
 */
const PREFIX = `
WITH RECURSIVE
p(now_ms, stale_ms, parked, project_filter) AS (SELECT ?, ?, ?, ?),
resolved(id) AS (
  SELECT node_id FROM task WHERE role IN (${RESOLVED_SQL})
),
blocking_edge(blocker, blocked) AS (
  SELECT e.blocker, e.blocked
  FROM edge e
  JOIN node nb ON nb.id = e.blocker
  JOIN node nd ON nd.id = e.blocked
  WHERE nb.kind <> 'milestone' OR nd.kind <> 'milestone'
),
seq_edge(blocker, blocked) AS (
  SELECT e.blocker, e.blocked
  FROM edge e
  JOIN node nb ON nb.id = e.blocker
  JOIN node nd ON nd.id = e.blocked
  WHERE nb.kind = 'milestone' AND nd.kind = 'milestone'
),
anc(target, id) AS (
  SELECT blocked, blocker FROM blocking_edge
  UNION
  SELECT a.target, be.blocker
  FROM anc a
  JOIN blocking_edge be ON be.blocked = a.id
  WHERE a.id NOT IN (SELECT id FROM resolved)
),
unresolved_anc(target, id) AS (
  SELECT target, id FROM anc WHERE id NOT IN (SELECT id FROM resolved)
),
descendant(target, id) AS (
  SELECT blocker, blocked FROM blocking_edge
  UNION
  SELECT d.target, be.blocked
  FROM descendant d
  JOIN blocking_edge be ON be.blocker = d.id
),
fanout(id, n) AS (SELECT target, COUNT(*) FROM descendant GROUP BY target),
live_claim(node_id) AS (
  SELECT c.node_id FROM claim c, p WHERE p.now_ms - c.heartbeat_at_ms <= p.stale_ms
),
member(milestone_id, node_id, role, updated_at_ms, external_id) AS (
  SELECT t.milestone_id, t.node_id, t.role, t.updated_at_ms, n.external_id
  FROM task t
  JOIN node n ON n.id = t.node_id
  WHERE t.milestone_id IS NOT NULL
),
review_valid(milestone_id) AS (
  SELECT r.milestone_id
  FROM review r
  WHERE NOT EXISTS (
      SELECT 1 FROM member m
      WHERE m.milestone_id = r.milestone_id
        AND m.external_id NOT IN (
          SELECT member_external_id FROM review_member rm
          WHERE rm.milestone_id = r.milestone_id
        )
    )
    AND NOT EXISTS (
      SELECT 1 FROM review_member rm
      WHERE rm.milestone_id = r.milestone_id
        AND rm.member_external_id NOT IN (
          SELECT m.external_id FROM member m
          WHERE m.milestone_id = r.milestone_id
        )
    )
    AND NOT EXISTS (
      SELECT 1 FROM member m
      WHERE m.milestone_id = r.milestone_id
        AND m.updated_at_ms IS NOT NULL
        AND m.updated_at_ms > r.recorded_at_ms
    )
),
milestone_state(id, member_count, open_count, dep_blocked, review_recorded) AS (
  SELECT
    m.node_id,
    COUNT(mem.node_id),
    COALESCE(SUM(CASE WHEN mem.role NOT IN (${RESOLVED_SQL}) THEN 1 ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN mem.node_id IN (SELECT target FROM unresolved_anc) THEN 1 ELSE 0 END), 0),
    EXISTS (SELECT 1 FROM review_valid rv WHERE rv.milestone_id = m.node_id)
  FROM milestone m
  LEFT JOIN member mem ON mem.milestone_id = m.node_id
  GROUP BY m.node_id
),
milestone_gate_open(id) AS (
  SELECT id FROM milestone_state
  WHERE member_count > 0 AND open_count = 0 AND dep_blocked = 0 AND review_recorded
),
m_anc(target, id) AS (
  SELECT blocked, blocker FROM seq_edge
  UNION
  SELECT a.target, se.blocker
  FROM m_anc a
  JOIN seq_edge se ON se.blocked = a.id
),
gate(task_id, milestone_id) AS (
  SELECT t.node_id, a.id
  FROM task t
  JOIN m_anc a ON a.target = t.milestone_id
  JOIN milestone_state ms ON ms.id = a.id
  WHERE ms.member_count > 0 AND a.id NOT IN (SELECT id FROM milestone_gate_open)
),
classified AS (
  SELECT
    t.node_id,
    n.external_id AS id,
    pr.external_id AS project,
    t.url,
    t.title,
    t.role,
    nm.external_id AS milestone,
    t.target_kind,
    t.human_interactive,
    t.injected,
    t.priority,
    t.branch_hint,
    t.labels,
    t.updated_at_ms,
    c.agent AS claim_agent,
    c.heartbeat_at_ms AS claim_heartbeat_at_ms,
    CASE
      WHEN c.node_id IS NULL THEN NULL
      WHEN lc.node_id IS NOT NULL THEN 1
      ELSE 0
    END AS claim_live,
    (SELECT group_concat(nx.external_id, ',' ORDER BY nx.external_id)
       FROM unresolved_anc ua JOIN node nx ON nx.id = ua.id
      WHERE ua.target = t.node_id) AS blocked_by,
    (SELECT group_concat(ng.external_id, ',' ORDER BY ng.external_id)
       FROM gate g JOIN node ng ON ng.id = g.milestone_id
      WHERE g.task_id = t.node_id) AS gated_by,
    COALESCE(f.n, 0) AS fanout,
    CASE
      WHEN t.role = 'verified' THEN 'verified'
      WHEN t.role = 'canceled' THEN 'canceled'
      WHEN t.role IN (${STARTED_SQL}) THEN 'in-flight'
      WHEN lc.node_id IS NOT NULL THEN 'in-flight'
      WHEN t.role = 'backlog' THEN 'dormant'
      WHEN EXISTS (SELECT 1 FROM unresolved_anc ua WHERE ua.target = t.node_id)
        OR EXISTS (SELECT 1 FROM gate g WHERE g.task_id = t.node_id) THEN 'blocked'
      WHEN t.human_interactive = 1
        OR t.target_kind = 'human-only'
        OR t.role IN (SELECT je.value FROM p, json_each(p.parked) je) THEN 'human-blocked'
      WHEN t.role = 'available' THEN 'available'
      ELSE 'dormant'
    END AS classification
  FROM task t
  JOIN node n ON n.id = t.node_id
  JOIN project pr ON pr.id = t.project_id
  LEFT JOIN node nm ON nm.id = t.milestone_id
  LEFT JOIN claim c ON c.node_id = t.node_id
  LEFT JOIN live_claim lc ON lc.node_id = t.node_id
  LEFT JOIN fanout f ON f.id = t.node_id
)
`;

const PROJECT_FILTER =
  '((SELECT project_filter FROM p) IS NULL OR project = (SELECT project_filter FROM p))';

/**
 * The frontier's order is total and deterministic, so two runs over one graph
 * always agree: injected work first, then priority (lower is more urgent,
 * absent sorts last), then descendant fan-out (more downstream work unblocked
 * first — the critical-path signal), then id. Milestone order is deliberately
 * absent: sequencing is enforced by the gate, not the ranking.
 */
const RANK_ORDER =
  'ORDER BY injected DESC, (priority IS NULL) ASC, priority ASC, fanout DESC, id ASC';

function params(options: DeriveOptions, project?: string): SqlValue[] {
  return [
    options.nowMs ?? Date.now(),
    options.staleAfterMs ?? Number.MAX_SAFE_INTEGER,
    JSON.stringify(options.parkedRoles ?? DEFAULT_PARKED_ROLES),
    project ?? null,
  ];
}

/** Every task, classified, ordered by external id. */
export function classifiedNodes(
  db: Database,
  options: DeriveOptions
): ClassifiedNode[] {
  return db
    .all(
      `${PREFIX} SELECT * FROM classified WHERE ${PROJECT_FILTER} ORDER BY id`,
      params(options)
    )
    .map(toClassified);
}

/** The ranked available frontier, most urgent first. */
export function frontier(
  db: Database,
  options: DeriveOptions,
  project?: string
): ClassifiedNode[] {
  return db
    .all(
      `${PREFIX} SELECT * FROM classified WHERE classification = 'available' AND ${PROJECT_FILTER} ${RANK_ORDER}`,
      params(options, project)
    )
    .map(toClassified);
}

/** Every declared milestone's derived state, ordered by project then id. */
export function milestoneStates(
  db: Database,
  options: DeriveOptions
): MilestoneState[] {
  const rows = db.all(
    `${PREFIX}
     SELECT
       n.external_id AS id,
       pr.external_id AS project,
       m.name,
       ms.member_count,
       ms.open_count,
       ms.dep_blocked,
       ms.review_recorded,
       (SELECT group_concat(mem.external_id, ',' ORDER BY mem.external_id)
          FROM member mem WHERE mem.milestone_id = ms.id) AS members
     FROM milestone_state ms
     JOIN milestone m ON m.node_id = ms.id
     JOIN node n ON n.id = ms.id
     JOIN project pr ON pr.id = m.project_id
     ORDER BY project, id`,
    params(options)
  );

  return rows.map((row) => ({
    id: text(row.id) ?? '',
    project: text(row.project) ?? '',
    name: text(row.name) ?? '',
    members: splitList(row.members),
    memberCount: integer(row.member_count),
    openCount: integer(row.open_count),
    readyForReview:
      integer(row.member_count) > 0 &&
      integer(row.open_count) === 0 &&
      integer(row.dep_blocked) === 0,
    reviewRecorded: integer(row.review_recorded) === 1,
  }));
}

/** Every edge, by external ids, ordered. */
export function edges(db: Database): {blocker: string; blocked: string}[] {
  return db
    .all(
      `SELECT nb.external_id AS blocker, nd.external_id AS blocked
       FROM edge e
       JOIN node nb ON nb.id = e.blocker
       JOIN node nd ON nd.id = e.blocked
       ORDER BY blocker, blocked`
    )
    .map((row) => ({
      blocker: text(row.blocker) ?? '',
      blocked: text(row.blocked) ?? '',
    }));
}

/**
 * The projects the document surfaces: declared ones, plus any named by a task
 * or milestone — typically a cross-project ancestor pulled in to complete the
 * dependency closure. An undeclared project is partial: its set describes only
 * what happened to be fetched.
 */
export function projects(
  db: Database
): {id: string; name: string; declared: boolean}[] {
  return db
    .all(
      `SELECT p.external_id AS id, p.name, p.declared
       FROM project p
       WHERE p.declared = 1
          OR EXISTS (SELECT 1 FROM task t WHERE t.project_id = p.id)
          OR EXISTS (SELECT 1 FROM milestone m WHERE m.project_id = p.id)
       ORDER BY id`
    )
    .map((row) => ({
      id: text(row.id) ?? '',
      name: text(row.name) ?? '',
      declared: integer(row.declared) === 1,
    }));
}

export function cursors(db: Database): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of db.all(
    'SELECT source, value FROM cursor ORDER BY source'
  )) {
    out[text(row.source) ?? ''] = text(row.value) ?? '';
  }
  return out;
}

/**
 * What the writes could not prevent. Kind conflicts, task↔milestone edges,
 * cycles, and malformed timestamps are rejected at write time; what remains is
 * global structure no single write can judge:
 *
 * - a placeholder edge endpoint — the node has not been written *yet*
 *   (transient mid-sync, or a fetch that never completed);
 * - a milestone that tasks name but nobody declared, whose gate therefore
 *   cannot be evaluated;
 * - two projects that block each other, so neither can finish first;
 * - a cycle, as a safety net for a hand-edited or imported database.
 */
export function anomalies(db: Database): Anomaly[] {
  const out: Anomaly[] = [];

  const cycleNodes = db
    .all(
      `WITH RECURSIVE reach(target, id) AS (
         SELECT blocker, blocked FROM edge
         UNION
         SELECT r.target, e.blocked FROM reach r JOIN edge e ON e.blocker = r.id
       )
       SELECT DISTINCT n.external_id AS id
       FROM reach r JOIN node n ON n.id = r.target
       WHERE r.target = r.id
       ORDER BY id`
    )
    .map((row) => text(row.id) ?? '');
  if (cycleNodes.length > 0) {
    out.push({
      kind: 'cycle',
      nodes: cycleNodes,
      detail: `dependency cycle through ${cycleNodes.join(', ')}; the CLI refuses cycle-closing edges, so this database was edited by something else — remove an edge to break the loop`,
    });
  }

  for (const row of db.all(
    `SELECT nb.external_id AS blocker, nb.kind AS blocker_kind,
            nd.external_id AS blocked
     FROM edge e
     JOIN node nb ON nb.id = e.blocker
     JOIN node nd ON nd.id = e.blocked
     WHERE nb.kind = 'unknown' OR nd.kind = 'unknown'
     ORDER BY blocker, blocked`
  )) {
    const blocker = text(row.blocker) ?? '';
    const blocked = text(row.blocked) ?? '';
    out.push({
      kind: 'dangling-edge',
      nodes: [blocker, blocked],
      detail:
        text(row.blocker_kind) === 'unknown'
          ? `blocker ${blocker} of ${blocked} is not in the graph; ${blocked} is held blocked until ${blocker} is added`
          : `${blocker} blocks ${blocked}, which is not in the graph; the edge schedules nothing — add ${blocked} if it is in scope`,
    });
  }

  for (const row of db.all(
    `SELECT nm.external_id AS milestone,
            group_concat(n.external_id, ',' ORDER BY n.external_id) AS members,
            COUNT(*) AS n
     FROM task t
     JOIN node nm ON nm.id = t.milestone_id AND nm.kind = 'unknown'
     JOIN node n ON n.id = t.node_id
     GROUP BY nm.external_id
     ORDER BY milestone`
  )) {
    const milestone = text(row.milestone) ?? '';
    out.push({
      kind: 'unknown-milestone',
      nodes: splitList(row.members),
      detail: `milestone ${milestone} is not in the graph, so its gate cannot be evaluated; ${String(integer(row.n))} task(s) in it are NOT gated on any milestone — add it`,
    });
  }

  const pairs = db.all(
    `WITH pe(a, b) AS (
       SELECT DISTINCT tb.project_id, td.project_id
       FROM edge e
       JOIN task tb ON tb.node_id = e.blocker
       JOIN task td ON td.node_id = e.blocked
       WHERE tb.project_id <> td.project_id
     )
     SELECT x.a AS a_id, x.b AS b_id,
            pa.external_id AS a, pb.external_id AS b
     FROM pe x
     JOIN pe y ON y.a = x.b AND y.b = x.a
     JOIN project pa ON pa.id = x.a
     JOIN project pb ON pb.id = x.b
     WHERE x.a < x.b
     ORDER BY a, b`
  );
  for (const pair of pairs) {
    const involved = db
      .all(
        `SELECT DISTINCT n.external_id AS id
         FROM edge e
         JOIN task tb ON tb.node_id = e.blocker
         JOIN task td ON td.node_id = e.blocked
         JOIN node n ON n.id = e.blocker OR n.id = e.blocked
         WHERE (tb.project_id = ? AND td.project_id = ?)
            OR (tb.project_id = ? AND td.project_id = ?)
         ORDER BY id`,
        [
          integer(pair.a_id),
          integer(pair.b_id),
          integer(pair.b_id),
          integer(pair.a_id),
        ]
      )
      .map((row) => text(row.id) ?? '');
    out.push({
      kind: 'cross-project-reverse',
      nodes: involved,
      detail: `projects ${text(pair.a) ?? ''} and ${text(pair.b) ?? ''} block each other; neither can be completed first`,
    });
  }

  return out;
}

function toClassified(row: Row): ClassifiedNode {
  const role = text(row.role) ?? '';
  const targetKind = text(row.target_kind) ?? '';
  const rawLabels: unknown = JSON.parse(text(row.labels) ?? '[]');
  const classification = text(row.classification) ?? 'dormant';
  const blockedBy = splitList(row.blocked_by);
  const gatedBy = splitList(row.gated_by);
  const updatedAtMs = row.updated_at_ms;

  return {
    node: {
      id: text(row.id) ?? '',
      project: text(row.project) ?? '',
      url: text(row.url) ?? '',
      title: text(row.title) ?? '',
      // The CHECK constraints validated these on the way in; the guards keep the
      // types honest without trusting a cast.
      role: isRole(role) ? role : 'backlog',
      milestone: text(row.milestone),
      targetKind: isTargetKind(targetKind) ? targetKind : 'pr',
      humanInteractive: integer(row.human_interactive) === 1,
      injected: integer(row.injected) === 1,
      priority: typeof row.priority === 'number' ? row.priority : null,
      branchHint: text(row.branch_hint),
      labels: Array.isArray(rawLabels)
        ? rawLabels.filter(
            (label): label is string => typeof label === 'string'
          )
        : [],
      updatedAt:
        typeof updatedAtMs === 'number'
          ? new Date(updatedAtMs).toISOString()
          : null,
    },
    classification: classification as Classification,
    effectiveBlocked: blockedBy.length > 0 || gatedBy.length > 0,
    blockedBy,
    gatedBy,
    claim:
      row.claim_agent === null || row.claim_agent === undefined
        ? null
        : {
            agent: text(row.claim_agent) ?? '',
            live: integer(row.claim_live) === 1,
            heartbeatAt: new Date(
              integer(row.claim_heartbeat_at_ms)
            ).toISOString(),
          },
    fanout: integer(row.fanout),
  };
}

function splitList(value: unknown): string[] {
  const joined = text(value);
  return joined === null || joined === '' ? [] : joined.split(',');
}

/** SQLite hands values back as `string | number | bigint | null | Uint8Array`. */
function text(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint')
    return String(value);
  return null;
}

function integer(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  return 0;
}
