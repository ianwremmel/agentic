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
import type { GraphEdge, GraphNode, GraphSnapshot, Project } from './types.mts';

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
 *   verified/canceled → exclusion (done/failed/in-flight) → dormant (backlog)
 *   → permanently-blocked → blocked → human-blocked → available → in-flight
 *
 * Two orderings there carry weight:
 *
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
  const milestoneStates = computeMilestoneStates(
    snapshot.nodes,
    snapshot.milestones,
    snapshot.reviews,
    analysis,
  );

  const excludedBy = new Map<string, ExclusionKind>(
    snapshot.exclusions.map((e) => [e.id, e.kind]),
  );
  const failedIds = new Set(
    snapshot.exclusions.filter((e) => e.kind === 'failed').map((e) => e.id),
  );
  const roleOf = new Map(snapshot.nodes.map((n) => [n.id, n.role]));

  const classified: ClassifiedNode[] = snapshot.nodes.map((node) => {
    const excluded = excludedBy.get(node.id) ?? null;
    const blockedBy = analysis.unresolvedAncestors.get(node.id) ?? [];
    const gatedBy = gatingMilestones(node, milestoneStates);

    // An ancestor the orchestrator marked `failed` will not progress, and a
    // ticket behind it can never become available. A `canceled` ancestor is a
    // different thing entirely — cancellation unblocks downstream work, so it
    // never lands a dependent here.
    const deadAncestor = [...(analysis.ancestors.get(node.id) ?? [])].find(
      (id) => failedIds.has(id) && !isResolved(roleOf.get(id) ?? 'available'),
    );

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
  if (node.role === 'verified') return 'verified';
  if (node.role === 'canceled') return 'canceled';

  // The orchestrator already knows about this one; keep it out of the
  // scheduling sections but keep reporting its current state.
  if (context.excluded === 'done') return 'verified';
  if (context.excluded === 'failed') return 'permanently-blocked';
  if (context.excluded === 'in-flight') return 'in-flight';

  // A `backlog` ticket is not eligible to be picked up, full stop — whether or
  // not something also blocks it. Its dormancy outranks every scheduling
  // signal: calling it `blocked` would imply it becomes workable once its
  // blockers clear (it does not — a human must promote it first), and calling
  // it `human-blocked` would alert a human about work nobody has started.
  // `paused` and `awaiting-external` are NOT this: they are parked mid-flight,
  // and fall through to `human-blocked` below.
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

  if (node.role === 'available') return 'available';
  if (GROUP_OF[node.role] === 'started') return 'in-flight';
  return 'dormant';
}

/**
 * A project is terminal when nothing is left that the orchestrator could act
 * on — now or after some other ticket resolves. `dormant` backlog tickets do
 * not hold a project open: the protocol says a backlog ticket is not eligible
 * to be picked up, so waiting on one would mean ticking forever until a human
 * promotes it.
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
  const pairs = new Map<string, GraphEdge[]>();
  for (const edge of snapshot.edges) {
    const from = projectOf.get(edge.blocker);
    const to = projectOf.get(edge.blocked);
    if (from === undefined || to === undefined || from === to) continue;
    const key = `${from} ${to}`;
    const bucket = pairs.get(key);
    if (bucket) bucket.push(edge);
    else pairs.set(key, [edge]);
  }

  const reported = new Set<string>();
  for (const [key, edges] of pairs) {
    const [from = '', to = ''] = key.split(' ');
    const reverse = pairs.get(`${to} ${from}`);
    if (reverse === undefined) continue;
    const pairKey = [from, to].sort().join(' ');
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
