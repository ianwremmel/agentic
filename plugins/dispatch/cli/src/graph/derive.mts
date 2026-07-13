import {
  GROUP_OF,
  isResolved,
  type ExclusionKind,
  type Role,
} from '../roles.mts';
import { analyzeBlocking, type BlockingAnalysis } from './blocking.mts';
import {
  computeMilestoneStates,
  gatingMilestones,
  type MilestoneState,
} from './milestones.mts';
import { rankAvailable } from './rank.mts';
import type {
  Exclusion,
  GraphEdge,
  GraphNode,
  GraphSnapshot,
  Project,
} from './types.mts';

export const DEFAULT_PARKED_ROLES: readonly Role[] = [
  'awaiting-external',
  'paused',
];

export interface DeriveOptions {
  /** Roles that mean "parked pending a human". Tracker-dependent. */
  parkedRoles?: readonly Role[];
}

export type Classification =
  | 'available'
  | 'blocked'
  | 'human-blocked'
  | 'permanently-blocked'
  | 'in-flight'
  | 'dormant'
  | 'verified'
  | 'canceled';

export interface ClassifiedNode {
  node: GraphNode;
  classification: Classification;
  /**
   * The ticket cannot start: it has an unresolved ancestor, or an earlier
   * milestone is still awaiting review.
   *
   * This is computed from the graph alone and is NOT a restatement of
   * `classification === 'blocked'`. A ticket can be effectively blocked and
   * still classify elsewhere — a `verified` ticket whose own ancestor is still
   * open, or a `backlog` ticket that is dormant regardless. Those are worth
   * seeing, and collapsing the two would hide them.
   */
  effectiveBlocked: boolean;
  /** Every unresolved ancestor — transitive, not just the direct blockers. */
  blockedBy: string[];
  /** Earlier milestones awaiting review, if any. Non-empty implies `blocked`. */
  gatedBy: string[];
  /** Why the node can never become available. Set only on `permanently-blocked`. */
  permanentReason: string | null;
  /** The orchestrator's own exclusion, echoed back. */
  excluded: ExclusionKind | null;
}

export interface Anomaly {
  kind:
    'cycle' | 'dangling-edge' | 'cross-project-reverse' | 'unknown-milestone';
  nodes: string[];
  detail: string;
}

export interface ProjectCounts {
  project: string;
  /** Only some of this project's tickets were fetched — see Project.declared. */
  partial: boolean;
  total: number;
  available: number;
  blocked: number;
  humanBlocked: number;
  permanentlyBlocked: number;
  inFlight: number;
  dormant: number;
  verified: number;
  canceled: number;
  /** No work the orchestrator can act on, now or later. */
  terminal: boolean;
}

export interface DerivedGraph {
  projects: {
    id: string;
    name: string;
    partial: boolean;
    terminal: boolean;
  }[];
  nodes: ClassifiedNode[];
  edges: GraphEdge[];
  available: ClassifiedNode[];
  blocked: ClassifiedNode[];
  humanBlocked: ClassifiedNode[];
  permanentlyBlocked: ClassifiedNode[];
  milestones: MilestoneState[];
  counts: ProjectCounts[];
  anomalies: Anomaly[];
  cursors: Record<string, string>;
  analysis: BlockingAnalysis;
}

/**
 * Turn a raw snapshot into the derived project-graph document.
 *
 * All graph reasoning lives here, on the producer side, so the orchestrator
 * that reads the document never re-derives blocking, ranking, or cycles.
 *
 * Classification precedence, highest first:
 *
 *   verified/canceled (role) → failed/in-flight exclusion → in-flight (started)
 *   → dormant (backlog) → permanently-blocked → blocked → human-blocked
 *   → available
 *
 * Three orderings there carry weight:
 *
 * - `in-flight` outranks the waiting buckets. Work already underway is not
 *   "blocked" and does not need a human — someone is on it.
 * - `dormant` outranks everything schedulable. A `backlog` ticket is not
 *   eligible to be picked up whatever else is true of it, so it is never
 *   reported as blocked (which would imply clearing its blockers makes it
 *   workable) or as human-blocked (which would alert a human to unstarted work).
 * - `blocked` outranks `human-blocked`. A human-interactive ticket whose
 *   ancestors are still open is not yet the human's problem; it becomes
 *   `human-blocked` the moment they resolve, so the alert fires once, when it is
 *   actionable.
 */
export function derive(
  snapshot: GraphSnapshot,
  options: DeriveOptions = {},
): DerivedGraph {
  const parked = new Set<Role>(options.parkedRoles ?? DEFAULT_PARKED_ROLES);

  const analysis = analyzeBlocking(snapshot.nodes, snapshot.edges);

  const excludedBy = new Map<string, ExclusionKind>(
    snapshot.exclusions.map((e) => [e.id, e.kind]),
  );

  const { permanentIds, deadAncestorOf } = findPermanentlyStuck(
    snapshot.nodes,
    snapshot.exclusions,
    analysis,
  );

  // Milestone readiness has to know which members are permanently stuck, so it
  // is computed after them and before classification, which consumes the gates.
  const milestoneStates = computeMilestoneStates(
    snapshot.nodes,
    snapshot.milestones,
    snapshot.reviews,
    analysis,
    permanentIds,
  );

  const classified: ClassifiedNode[] = snapshot.nodes.map((node) => {
    const excluded = excludedBy.get(node.id) ?? null;
    const blockedBy = analysis.unresolvedAncestors.get(node.id) ?? [];
    const gatedBy = gatingMilestones(node, milestoneStates);
    const deadAncestor = deadAncestorOf.get(node.id);

    return {
      node,
      classification: classify(node, {
        excluded,
        blockedBy,
        gatedBy,
        deadAncestor,
        parked,
      }),
      effectiveBlocked: blockedBy.length > 0 || gatedBy.length > 0,
      blockedBy,
      gatedBy,
      permanentReason:
        deadAncestor === undefined ? null : `ancestor-failed:${deadAncestor}`,
      excluded,
    };
  });

  const projects = withInferredProjects(snapshot.projects, snapshot.nodes);

  const bucket = (kind: Classification): ClassifiedNode[] =>
    classified.filter((c) => c.classification === kind);

  const availableRanked = rankAvailable(
    bucket('available').map((c) => c.node),
    analysis,
  );
  const byId = new Map(classified.map((c) => [c.node.id, c]));

  return {
    projects: projects.map((project) => ({
      id: project.id,
      name: project.name,
      partial: !project.declared,
      // A project whose tickets were only partially fetched can never be called
      // finished: the unfetched tickets are invisible, not absent.
      terminal:
        project.declared &&
        isTerminalProject(classified, excludedBy, project.id),
    })),
    nodes: classified,
    edges: snapshot.edges,
    available: availableRanked
      .map((node) => byId.get(node.id))
      .filter(isPresent),
    blocked: bucket('blocked'),
    humanBlocked: bucket('human-blocked'),
    permanentlyBlocked: bucket('permanently-blocked'),
    milestones: [...milestoneStates.values()].sort(
      (a, b) => a.project.localeCompare(b.project) || a.sortOrder - b.sortOrder,
    ),
    counts: projects.map((project) =>
      countProject(classified, excludedBy, project),
    ),
    anomalies: findAnomalies(snapshot, analysis),
    cursors: snapshot.cursors,
    analysis,
  };
}

/**
 * Tickets that can never become available: the ones the orchestrator marked
 * `failed`, and the ones standing behind such a ticket.
 *
 * A `canceled` ancestor is a different thing entirely — cancellation unblocks
 * downstream work, and the blocking walk already stops there, so it never lands
 * a dependent here.
 *
 * Shared with the store, which needs the same set to judge milestone readiness
 * when it prunes stale review records.
 */
export function findPermanentlyStuck(
  nodes: readonly GraphNode[],
  exclusions: readonly Exclusion[],
  analysis: BlockingAnalysis,
): { permanentIds: Set<string>; deadAncestorOf: Map<string, string> } {
  const failedIds = new Set(
    exclusions.filter((e) => e.kind === 'failed').map((e) => e.id),
  );
  const roleOf = new Map(nodes.map((n) => [n.id, n.role]));

  const permanentIds = new Set<string>();
  const deadAncestorOf = new Map<string, string>();

  for (const node of nodes) {
    if (failedIds.has(node.id) && !isResolved(node.role)) {
      permanentIds.add(node.id);
      continue;
    }
    const dead = [...(analysis.ancestors.get(node.id) ?? [])].find(
      (id) => failedIds.has(id) && !isResolved(roleOf.get(id) ?? 'available'),
    );
    if (dead !== undefined) {
      deadAncestorOf.set(node.id, dead);
      permanentIds.add(node.id);
    }
  }

  return { permanentIds, deadAncestorOf };
}

function classify(
  node: GraphNode,
  context: {
    excluded: ExclusionKind | null;
    blockedBy: string[];
    gatedBy: string[];
    deadAncestor: string | undefined;
    parked: ReadonlySet<Role>;
  },
): Classification {
  // The tracker's role is authoritative for what a ticket IS. An exclusion says
  // what the orchestrator is DOING about it, and may keep it off the frontier —
  // but it never overwrites the role, or a `delivered` ticket the orchestrator
  // has finished with would be tallied `verified` and its project could report
  // itself complete with unverified work in it.
  if (node.role === 'verified') return 'verified';
  if (node.role === 'canceled') return 'canceled';

  if (context.excluded === 'failed') return 'permanently-blocked';
  if (context.excluded === 'in-flight') return 'in-flight';

  // Work already underway is in flight, whatever else is true of it. A ticket
  // someone is actively working is not "blocked" (that would put started work in
  // a bucket the orchestrator reads as waiting), and not "human-blocked" (a
  // human-led ticket in progress means a human is already on it).
  if (GROUP_OF[node.role] === 'started') return 'in-flight';

  // A `backlog` ticket is not eligible to be picked up, full stop — whether or
  // not something also blocks it. Calling it `blocked` would imply it becomes
  // workable once its blockers clear (it does not — a human must promote it
  // first), and calling it `human-blocked` would alert a human about work nobody
  // has started. `paused` and `awaiting-external` are NOT this: they are parked
  // mid-flight, and fall through to `human-blocked` below.
  if (node.role === 'backlog') return 'dormant';

  if (context.deadAncestor !== undefined) return 'permanently-blocked';
  if (context.blockedBy.length > 0 || context.gatedBy.length > 0)
    return 'blocked';

  if (
    node.humanInteractive ||
    node.targetKind === 'human-only' ||
    context.parked.has(node.role)
  ) {
    return 'human-blocked';
  }

  if (node.role === 'available') {
    // The orchestrator has finished with it even though the tracker has not
    // caught up. Never schedule it again — but do not call it verified either.
    return context.excluded === 'done' ? 'in-flight' : 'available';
  }
  return 'dormant';
}

/**
 * A project is terminal only when every ticket is `verified`, `canceled`, or
 * permanently-blocked.
 *
 * `dormant` backlog tickets DO hold a project open. They are not eligible to be
 * picked up, so the frontier can be empty while they sit there — but a backlog
 * ticket can still be promoted to `available`, so the project is not finished
 * and must not be reported as such. An orchestrator pointed at a project whose
 * work has not been promoted yet will find nothing to dispatch and say so; that
 * is the honest answer, and it is not the same as done.
 */
function isTerminalProject(
  classified: readonly ClassifiedNode[],
  excludedBy: ReadonlyMap<string, ExclusionKind>,
  project: string,
): boolean {
  return !classified.some(
    (c) =>
      c.node.project === project &&
      (c.classification === 'available' ||
        c.classification === 'blocked' ||
        c.classification === 'human-blocked' ||
        c.classification === 'in-flight' ||
        c.classification === 'dormant' ||
        excludedBy.get(c.node.id) === 'in-flight'),
  );
}

function countProject(
  classified: readonly ClassifiedNode[],
  excludedBy: ReadonlyMap<string, ExclusionKind>,
  project: Project,
): ProjectCounts {
  const own = classified.filter((c) => c.node.project === project.id);
  const tally = (kind: Classification): number =>
    own.filter((c) => c.classification === kind).length;

  return {
    project: project.id,
    partial: !project.declared,
    total: own.length,
    available: tally('available'),
    blocked: tally('blocked'),
    humanBlocked: tally('human-blocked'),
    permanentlyBlocked: tally('permanently-blocked'),
    inFlight: tally('in-flight'),
    dormant: tally('dormant'),
    verified: tally('verified'),
    canceled: tally('canceled'),
    terminal:
      project.declared && isTerminalProject(classified, excludedBy, project.id),
  };
}

function findAnomalies(
  snapshot: GraphSnapshot,
  analysis: BlockingAnalysis,
): Anomaly[] {
  const anomalies: Anomaly[] = [];

  for (const cycle of analysis.cycles) {
    anomalies.push({
      kind: 'cycle',
      nodes: cycle,
      detail: `dependency cycle: ${cycle.join(' -> ')} -> ${cycle[0] ?? ''}`,
    });
  }

  // The two halves of a dangling edge are not the same problem, and reporting
  // them identically sends the reader after the wrong ticket. A missing blocker
  // holds real work back; a missing dependent is a ticket outside the fetch that
  // simply never gets scheduled.
  const known = new Set(snapshot.nodes.map((node) => node.id));
  for (const edge of analysis.danglingEdges) {
    anomalies.push({
      kind: 'dangling-edge',
      nodes: [edge.blocker, edge.blocked],
      detail: known.has(edge.blocker)
        ? `${edge.blocker} blocks ${edge.blocked}, which is not in the graph; ` +
          `the edge schedules nothing — fetch ${edge.blocked} if it is in scope`
        : `blocker ${edge.blocker} of ${edge.blocked} is not in the graph; ` +
          `${edge.blocked} is held blocked until ${edge.blocker} is fetched`,
    });
  }

  // A ticket in a milestone the fetch never returned. Its gate cannot be
  // evaluated, so it silently escapes milestone sequencing — the ticket looks
  // startable when an unreviewed milestone may well be standing in front of it.
  const knownMilestones = new Set(snapshot.milestones.map((m) => m.id));
  const orphans = new Map<string, string[]>();
  for (const node of snapshot.nodes) {
    if (node.milestone === null || knownMilestones.has(node.milestone))
      continue;
    const bucket = orphans.get(node.milestone);
    if (bucket) bucket.push(node.id);
    else orphans.set(node.milestone, [node.id]);
  }
  for (const [milestone, members] of orphans) {
    anomalies.push({
      kind: 'unknown-milestone',
      nodes: members.sort(),
      detail:
        `milestone ${milestone} is not in the graph, so its gate cannot be evaluated; ` +
        `${members.length} ticket(s) in it are NOT gated on any earlier milestone — fetch it`,
    });
  }

  // Cross-project reverse dependencies: two projects that each block the other.
  // Legal edge by edge, but together they mean neither project can be finished
  // first, which the orchestrator must surface rather than schedule around.
  const projectOf = new Map(snapshot.nodes.map((n) => [n.id, n.project]));
  // Keys join two project ids and are separated by NUL, not a space: a project
  // id is whatever the tracker calls a project ("owner/repo", or a name with a
  // space in it), and splitting a space-joined key would recover the wrong
  // halves — so a real reverse-dependency pair would go unreported.
  const pairs = new Map<string, GraphEdge[]>();
  for (const edge of snapshot.edges) {
    const from = projectOf.get(edge.blocker);
    const to = projectOf.get(edge.blocked);
    if (from === undefined || to === undefined || from === to) continue;
    const key = `${from}\u0000${to}`;
    const bucket = pairs.get(key);
    if (bucket) bucket.push(edge);
    else pairs.set(key, [edge]);
  }

  const reported = new Set<string>();
  for (const [key, edges] of pairs) {
    const [from = '', to = ''] = key.split('\u0000');
    const reverse = pairs.get(`${to}\u0000${from}`);
    if (reverse === undefined) continue;
    const pairKey = [from, to].sort().join('\u0000');
    if (reported.has(pairKey)) continue;
    reported.add(pairKey);

    const involved = [...edges, ...reverse].flatMap((e) => [
      e.blocker,
      e.blocked,
    ]);
    anomalies.push({
      kind: 'cross-project-reverse',
      nodes: [...new Set(involved)].sort(),
      detail: `projects ${from} and ${to} block each other; neither can be completed first`,
    });
  }

  return anomalies;
}

/**
 * A ticket can name a project the fetch never returned — a cross-project
 * ancestor pulled in to complete the dependency closure. Its tickets must still
 * appear, or they would be missing from every count, but the project is marked
 * undeclared: only the tickets that happened to be reachable were fetched, so
 * nothing can be concluded about whether the project is finished.
 */
function withInferredProjects(
  declared: readonly Project[],
  nodes: readonly GraphNode[],
): Project[] {
  const projects = [...declared];
  const seen = new Set(projects.map((project) => project.id));

  for (const node of nodes) {
    if (node.project === '' || seen.has(node.project)) continue;
    seen.add(node.project);
    projects.push({ id: node.project, name: node.project, declared: false });
  }

  return projects;
}

function isPresent<T>(value: T | undefined): value is T {
  return value !== undefined;
}
