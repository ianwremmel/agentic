import type {SqlValue} from '../db/database.mts';
import {nowIso} from '../db/time.mts';
import type {DeriveOptions} from './types.mts';

/** A session heartbeat older than this makes its claims stale. */
export const DEFAULT_STALE_AFTER_SECONDS = 300;

/**
 * The graph reasoning, as one CTE pipeline over the stores' tables. Every
 * query shares this prefix, so blocking, ranking, gating, and admission always
 * agree.
 *
 * Parameters, in order: now (RFC 3339), session staleness (seconds), and an
 * optional project filter (external id, or NULL for all).
 *
 * The pieces:
 *
 * - `membership` / `seq_edge` / `blocking_edge` — edge semantics by endpoint
 *   kind: ticket → milestone is membership, milestone → milestone is
 *   sequencing, everything else (including an edge touching a placeholder)
 *   is plain blocking, the safe default for an endpoint nobody has fetched.
 * - `anc` — the transitive blocker closure. Recursion continues only through
 *   an *unresolved* ticket or PR: a `verified`/`canceled` ticket does not
 *   block, and cancellation releases downstream work. A placeholder has no
 *   status, so it reads as unresolved and holds its dependents. Milestone
 *   ancestors are kept but filtered by openness in `blocker_view` — an open
 *   milestone does not block, a closed one does. A milestone's own readiness
 *   (`dep_blocked`) counts only non-milestone ancestors, so openness never
 *   depends on itself.
 * - `descendant`/`fanout` — transitive descendant counts, resolved or not: how
 *   much work an item gates, a ranking signal rather than a blocking one.
 * - `live_claim` — a claim is live while its session's heartbeat is fresh;
 *   workers hold no heartbeat of their own, so a dead server's claims go
 *   stale together.
 * - `review_valid` — a recorded review counts only while it covers exactly
 *   the current member set and no member moved after it was recorded.
 * - `milestone_state` / `milestone_open` / `gate` — a milestone is ready when
 *   it has members, all are resolved, and none carries an unresolved
 *   dependency; open once its review is also valid. A member of a milestone is
 *   gated while any sequencing ancestor of that milestone is not open.
 *   Readiness never looks at sequencing, which keeps milestone gating acyclic.
 * - `item` — the dispatchable universe: every ticket, plus every PR item. A
 *   bare PR (no `ticket_id`) is prompt work; a ticket-attached one is a unit
 *   of implementation its ticket-worker registered, inheriting the ticket's
 *   project. A PR item has no status; its lifecycle is its outcome row.
 * - `classified` — the derived classification, highest precedence first:
 *   resolved → in-flight (started status, or a live claim) → dormant
 *   (backlog) → blocked → human-blocked → available. A PR item whose outcome
 *   is `human-blocked` classifies human-blocked directly: it has no status to
 *   park, and the outcome is its worker saying "waiting on an operator".
 * - A `watch` row is a worker's PR wait handed to the server: the item reads
 *   as in-flight while it exists, is never queued while `watching`, and once
 *   the server fires it (the PR changed in a way the worker would act on)
 *   falls through to the `resume` rule.
 * - `queued` — what the scheduler may hand out, and as which pass. An
 *   `available` item with no outcome row is dispatchable as-is; a started item
 *   with no live claim and no outcome is a crashed run — its claim is stale or
 *   was already swept away with its session — re-served as `resume`; a
 *   recorded outcome re-admits the item for exactly one follow-up
 *   pass — `verify` for a delivered ticket (a bare PR is done at delivered),
 *   `finalize` for a decomposed parent whose subtasks all resolved, `retry`
 *   for a retryable failure, and `resume` for a ticket whose `human-blocked`
 *   outcome a later tracker update contradicts — the ticket was updated after
 *   the report and now reads available, so the human responded and unparked
 *   it. The timestamp guard keeps a stale local row (ingest lagging the
 *   worker's own park transition) from reading as a response. Nothing
 *   human-owned, parked, resolved, or held by a live claim is ever handed
 *   out.
 */
export const PREFIX = `
WITH RECURSIVE
p(now_ts, stale_s, project_filter) AS (SELECT ?, ?, ?),
mile(id) AS (SELECT node_id FROM milestone),
resolved_leaf(id) AS (
  SELECT node_id FROM ticket WHERE status IN ('verified','canceled')
  UNION
  SELECT o.node_id FROM outcome o
  JOIN pr ON pr.node_id = o.node_id
  WHERE o.outcome IN ('delivered','verified','canceled')
),
membership(member_id, milestone_id) AS (
  SELECT e.blocker, e.blocked
  FROM edge e
  JOIN node nb ON nb.id = e.blocker
  JOIN node nd ON nd.id = e.blocked
  WHERE nb.kind = 'ticket' AND nd.kind = 'milestone'
),
seq_edge(blocker, blocked) AS (
  SELECT e.blocker, e.blocked
  FROM edge e
  JOIN node nb ON nb.id = e.blocker
  JOIN node nd ON nd.id = e.blocked
  WHERE nb.kind = 'milestone' AND nd.kind = 'milestone'
),
blocking_edge(blocker, blocked) AS (
  SELECT e.blocker, e.blocked
  FROM edge e
  JOIN node nb ON nb.id = e.blocker
  JOIN node nd ON nd.id = e.blocked
  WHERE NOT (nb.kind = 'ticket' AND nd.kind = 'milestone')
    AND NOT (nb.kind = 'milestone' AND nd.kind = 'milestone')
),
anc(target, id) AS (
  SELECT blocked, blocker FROM blocking_edge
  UNION
  SELECT a.target, be.blocker
  FROM anc a
  JOIN blocking_edge be ON be.blocked = a.id
  WHERE a.id NOT IN (SELECT id FROM resolved_leaf)
),
unresolved_anc(target, id) AS (
  SELECT target, id FROM anc WHERE id NOT IN (SELECT id FROM resolved_leaf)
),
descendant(target, id) AS (
  SELECT blocker, blocked FROM blocking_edge
  UNION
  SELECT d.target, be.blocked
  FROM descendant d
  JOIN blocking_edge be ON be.blocker = d.id
),
fanout(id, n) AS (SELECT target, COUNT(*) FROM descendant GROUP BY target),
live_session(id) AS (
  SELECT s.id FROM session s, p
  WHERE unixepoch(p.now_ts) - unixepoch(s.heartbeat_at) <= p.stale_s
),
live_claim(node_id) AS (
  SELECT c.node_id FROM claim c JOIN live_session ls ON ls.id = c.session_id
),
member(milestone_id, node_id, status, updated_at, external_id) AS (
  SELECT mb.milestone_id, mb.member_id, t.status, t.updated_at, n.external_id
  FROM membership mb
  JOIN ticket t ON t.node_id = mb.member_id
  JOIN node n ON n.id = mb.member_id
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
        AND m.updated_at IS NOT NULL
        AND unixepoch(m.updated_at) > unixepoch(r.recorded_at)
    )
),
milestone_state(id, member_count, open_count, dep_blocked, review_recorded) AS (
  SELECT
    mi.node_id,
    COUNT(mem.node_id),
    COALESCE(SUM(CASE WHEN mem.status NOT IN ('verified','canceled') THEN 1 ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN EXISTS (
      SELECT 1 FROM unresolved_anc ua
      WHERE ua.target = mem.node_id AND ua.id NOT IN (SELECT id FROM mile)
    ) THEN 1 ELSE 0 END), 0),
    EXISTS (SELECT 1 FROM review_valid rv WHERE rv.milestone_id = mi.node_id)
  FROM milestone mi
  LEFT JOIN member mem ON mem.milestone_id = mi.node_id
  GROUP BY mi.node_id
),
milestone_open(id) AS (
  SELECT id FROM milestone_state
  WHERE member_count > 0 AND open_count = 0 AND dep_blocked = 0 AND review_recorded
),
blocker_view(target, id) AS (
  SELECT ua.target, ua.id FROM unresolved_anc ua
  WHERE ua.id NOT IN (SELECT id FROM mile)
  UNION
  SELECT ua.target, ua.id FROM unresolved_anc ua
  WHERE ua.id IN (SELECT id FROM mile)
    AND ua.id NOT IN (SELECT id FROM milestone_open)
),
m_anc(target, id) AS (
  SELECT blocked, blocker FROM seq_edge
  UNION
  SELECT a.target, se.blocker
  FROM m_anc a
  JOIN seq_edge se ON se.blocked = a.id
),
gate(item_id, milestone_id) AS (
  SELECT mb.member_id, a.id
  FROM membership mb
  JOIN m_anc a ON a.target = mb.milestone_id
  JOIN milestone_state ms ON ms.id = a.id
  WHERE ms.member_count > 0 AND a.id NOT IN (SELECT id FROM milestone_open)
),
item AS (
  SELECT
    t.node_id,
    n.external_id AS id,
    'ticket' AS kind,
    np.external_id AS project,
    NULL AS ticket,
    t.url,
    t.title,
    t.status,
    t.target_kind,
    t.requires_human,
    t.injected,
    t.priority,
    t.branch_hint,
    t.labels,
    t.updated_at
  FROM ticket t
  JOIN node n ON n.id = t.node_id
  JOIN node np ON np.id = t.project_id
  UNION ALL
  SELECT
    pr.node_id,
    n.external_id,
    'pr',
    np.external_id,
    nt.external_id,
    pr.url,
    pr.title,
    NULL,
    'pr',
    0,
    pr.injected,
    pr.priority,
    pr.branch,
    '[]',
    pr.updated_at
  FROM pr
  JOIN node n ON n.id = pr.node_id
  LEFT JOIN node nt ON nt.id = pr.ticket_id
  LEFT JOIN ticket t2 ON t2.node_id = pr.ticket_id
  LEFT JOIN node np ON np.id = t2.project_id
),
classified AS (
  SELECT
    i.*,
    c.session_id AS claim_session,
    c.actor AS claim_actor,
    c.worktree AS claim_worktree,
    c.branch AS claim_branch,
    c.claimed_at AS claim_claimed_at,
    CASE
      WHEN c.node_id IS NULL THEN NULL
      WHEN lc.node_id IS NOT NULL THEN 1
      ELSE 0
    END AS claim_live,
    o.outcome AS outcome,
    o.retryable AS outcome_retryable,
    o.detail AS outcome_detail,
    o.recorded_at AS outcome_recorded_at,
    (SELECT group_concat(nx.external_id, ',' ORDER BY nx.external_id)
       FROM blocker_view bv JOIN node nx ON nx.id = bv.id
      WHERE bv.target = i.node_id) AS blocked_by,
    (SELECT group_concat(ng.external_id, ',' ORDER BY ng.external_id)
       FROM gate g JOIN node ng ON ng.id = g.milestone_id
      WHERE g.item_id = i.node_id) AS gated_by,
    (SELECT group_concat(nm.external_id, ',' ORDER BY nm.external_id)
       FROM membership mb JOIN node nm ON nm.id = mb.milestone_id
      WHERE mb.member_id = i.node_id) AS milestones,
    COALESCE(f.n, 0) AS fanout,
    w.state AS watch_state,
    CASE
      WHEN i.kind = 'pr' AND o.outcome IN ('delivered', 'verified') THEN 'verified'
      WHEN i.kind = 'pr' AND o.outcome = 'canceled' THEN 'canceled'
      WHEN i.kind = 'pr' AND o.outcome = 'human-blocked' THEN 'human-blocked'
      WHEN i.status = 'verified' THEN 'verified'
      WHEN i.status = 'canceled' THEN 'canceled'
      WHEN i.status IN ('in-progress','in-review','finished','delivered') THEN 'in-flight'
      WHEN lc.node_id IS NOT NULL THEN 'in-flight'
      WHEN w.node_id IS NOT NULL THEN 'in-flight'
      WHEN i.status = 'backlog' THEN 'dormant'
      WHEN EXISTS (SELECT 1 FROM blocker_view bv WHERE bv.target = i.node_id)
        OR EXISTS (SELECT 1 FROM gate g WHERE g.item_id = i.node_id) THEN 'blocked'
      WHEN i.requires_human = 1
        OR i.target_kind = 'human-only'
        OR i.status IN ('paused', 'awaiting-external') THEN 'human-blocked'
      WHEN i.kind = 'pr' OR i.status = 'available' THEN 'available'
      ELSE 'dormant'
    END AS classification
  FROM item i
  LEFT JOIN claim c ON c.node_id = i.node_id
  LEFT JOIN live_claim lc ON lc.node_id = i.node_id
  LEFT JOIN fanout f ON f.id = i.node_id
  LEFT JOIN outcome o ON o.node_id = i.node_id
  LEFT JOIN watch w ON w.node_id = i.node_id
),
queued AS (
  SELECT *,
    CASE
      WHEN watch_state = 'watching' THEN NULL
      WHEN requires_human = 1
        OR classification IN ('verified', 'canceled', 'human-blocked', 'dormant')
        THEN NULL
      WHEN outcome IS NULL AND classification = 'available' THEN 'available'
      WHEN outcome IS NULL AND (claim_live IS NULL OR claim_live = 0)
        AND classification = 'in-flight' THEN 'resume'
      WHEN outcome = 'human-blocked' AND (claim_live IS NULL OR claim_live = 0)
        AND classification = 'available'
        AND updated_at IS NOT NULL
        AND unixepoch(updated_at) > unixepoch(outcome_recorded_at) THEN 'resume'
      WHEN outcome IS NULL OR claim_live = 1 THEN NULL
      WHEN outcome = 'delivered' AND kind = 'ticket' THEN 'verify'
      WHEN outcome = 'decomposed'
        AND NOT EXISTS (SELECT 1 FROM blocker_view bv WHERE bv.target = node_id)
        AND NOT EXISTS (SELECT 1 FROM gate g WHERE g.item_id = node_id)
        THEN 'finalize'
      WHEN outcome = 'failed' AND outcome_retryable = 1 THEN 'retry'
    END AS pass
  FROM classified
)
`;

export const PROJECT_FILTER =
  '((SELECT project_filter FROM p) IS NULL OR project = (SELECT project_filter FROM p))';

/**
 * The frontier's order is total and deterministic, so two runs over one graph
 * always agree: injected work first, then priority (lower is more urgent,
 * absent sorts last), then descendant fan-out (more downstream work unblocked
 * first — the critical-path signal), then id. Milestone order is deliberately
 * absent: sequencing is enforced by the gate, not the ranking.
 */
export const RANK_ORDER =
  'ORDER BY injected DESC, (priority IS NULL) ASC, priority ASC, fanout DESC, id ASC';

/**
 * The dispatch queue's order: injected work first (a runtime-injected ticket
 * or bare PR goes to the head without preempting anything in flight), then the
 * follow-up passes on work already invested in (resume, finalize, verify,
 * retry), then the ranked available frontier.
 */
export const QUEUE_ORDER = `ORDER BY
  (pass = 'available' AND injected = 1) DESC,
  CASE pass
    WHEN 'resume' THEN 0 WHEN 'finalize' THEN 1 WHEN 'verify' THEN 2
    WHEN 'retry' THEN 3 ELSE 4
  END ASC,
  (priority IS NULL) ASC, priority ASC, fanout DESC, id ASC`;

export function pipelineParams(options: DeriveOptions): SqlValue[] {
  return [
    options.now ?? nowIso(),
    options.staleAfterSeconds ?? DEFAULT_STALE_AFTER_SECONDS,
    options.project ?? null,
  ];
}
