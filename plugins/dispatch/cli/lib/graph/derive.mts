import {analyzeBlocking, type BlockingAnalysis} from './blocking.mts';
import {
  computeMilestoneStates,
  gatingMilestones,
  milestoneAncestry,
  type MilestoneState,
} from './milestones.mts';
import {rankAvailable} from './rank.mts';
import {GROUP_OF, type Role} from './roles.mts';
import type {
  Claim,
  GraphEdge,
  GraphNode,
  GraphSnapshot,
  Project,
} from './types.mts';

/** Roles that mean "parked pending a human" (§2.6). Tracker-dependent. */
export const DEFAULT_PARKED_ROLES: readonly Role[] = [
  'awaiting-external',
  'paused',
];

export interface DeriveOptions {
  parkedRoles?: readonly Role[];
  /** Now, in epoch ms — used to judge claim staleness. Defaults to `Date.now()`. */
  nowMs?: number;
  /** A claim older than this (ms) is dead and no longer holds its task. */
  staleAfterMs?: number;
}

export type Classification =
  | 'available'
  | 'blocked'
  | 'human-blocked'
  | 'in-flight'
  | 'dormant'
  | 'verified'
  | 'canceled';

/** The live/stale view of a task's claim, if any. */
export interface ClaimView {
  agent: string;
  live: boolean;
  heartbeatAt: string;
}

export interface ClassifiedNode {
  node: GraphNode;
  classification: Classification;
  /**
   * The task cannot start: an ancestor is unresolved, or a milestone gating its
   * own milestone still awaits review. Computed from the graph, not a restatement
   * of `classification === 'blocked'` — a `verified` task can still carry an open
   * ancestor, worth seeing.
   */
  effectiveBlocked: boolean;
  /** Every unresolved task ancestor — transitive, not just the direct blockers. */
  blockedBy: string[];
  /** Milestones gating this task, unreviewed. Non-empty implies `blocked`. */
  gatedBy: string[];
  /** The claim on this task, live or stale, or null if none. */
  claim: ClaimView | null;
}

export interface Anomaly {
  kind:
    | 'cycle'
    | 'dangling-edge'
    | 'cross-project-reverse'
    | 'unknown-milestone'
    | 'task-milestone-edge';
  nodes: string[];
  detail: string;
}

export interface ProjectCounts {
  project: string;
  partial: boolean;
  total: number;
  available: number;
  blocked: number;
  humanBlocked: number;
  inFlight: number;
  dormant: number;
  verified: number;
  canceled: number;
  /** No task the orchestrator can act on, now or later (§2.6 termination). */
  terminal: boolean;
}

export interface MilestoneCounts extends MilestoneState {
  available: number;
  blocked: number;
  humanBlocked: number;
  inFlight: number;
  dormant: number;
  verified: number;
  canceled: number;
}

export interface DerivedGraph {
  projects: {id: string; name: string; partial: boolean; terminal: boolean}[];
  nodes: ClassifiedNode[];
  edges: GraphEdge[];
  available: ClassifiedNode[];
  blocked: ClassifiedNode[];
  humanBlocked: ClassifiedNode[];
  milestones: MilestoneCounts[];
  counts: ProjectCounts[];
  anomalies: Anomaly[];
  cursors: Record<string, string>;
  analysis: BlockingAnalysis;
}

/**
 * Turn a raw snapshot into the derived project-graph document (§2.6). All graph
 * reasoning lives here, on the producer side, so the orchestrator that reads the
 * document never re-derives blocking, ranking, cycles, or claim staleness.
 *
 * Task dependencies and milestone sequencing share the edge table but are read
 * apart: an edge between two tasks is a dependency, an edge between two
 * milestones is sequencing, and a mixed edge is unsupported (surfaced as an
 * anomaly). Milestone readiness is computed from members alone, so gating stays
 * acyclic.
 */
export function derive(
  snapshot: GraphSnapshot,
  options: DeriveOptions = {}
): DerivedGraph {
  const parked = new Set<Role>(options.parkedRoles ?? DEFAULT_PARKED_ROLES);
  const nowMs = options.nowMs ?? Date.now();
  const staleAfterMs = options.staleAfterMs ?? Number.POSITIVE_INFINITY;

  const taskIds = new Set(snapshot.nodes.map((node) => node.id));
  const milestoneIds = new Set(snapshot.milestones.map((m) => m.id));

  const {taskEdges, milestoneEdges, mixedEdges} = partitionEdges(
    snapshot.edges,
    taskIds,
    milestoneIds
  );

  const analysis = analyzeBlocking(snapshot.nodes, taskEdges);
  const milestoneStates = computeMilestoneStates(
    snapshot.nodes,
    snapshot.milestones,
    snapshot.reviews,
    analysis
  );
  const ancestry = milestoneAncestry(snapshot.milestones, milestoneEdges);

  const claimOf = new Map<string, ClaimView>(
    snapshot.claims.map((claim) => [
      claim.id,
      viewClaim(claim, nowMs, staleAfterMs),
    ])
  );

  const classified: ClassifiedNode[] = snapshot.nodes.map((node) => {
    const blockedBy = analysis.unresolvedAncestors.get(node.id) ?? [];
    const gatedBy = gatingMilestones(node, milestoneStates, ancestry);
    const claim = claimOf.get(node.id) ?? null;

    return {
      node,
      classification: classify(node, {blockedBy, gatedBy, claim, parked}),
      effectiveBlocked: blockedBy.length > 0 || gatedBy.length > 0,
      blockedBy,
      gatedBy,
      claim,
    };
  });

  const projects = withInferredProjects(snapshot);
  const byId = new Map(classified.map((entry) => [entry.node.id, entry]));
  const bucket = (kind: Classification): ClassifiedNode[] =>
    classified.filter((entry) => entry.classification === kind);

  const availableRanked = rankAvailable(
    bucket('available').map((entry) => entry.node),
    analysis
  );

  return {
    projects: projects.map((project) => ({
      id: project.id,
      name: project.name,
      partial: !project.declared,
      terminal: project.declared && isTerminalProject(classified, project.id),
    })),
    nodes: classified,
    edges: snapshot.edges,
    available: availableRanked
      .map((node) => byId.get(node.id))
      .filter((entry) => entry !== undefined),
    blocked: bucket('blocked'),
    humanBlocked: bucket('human-blocked'),
    milestones: [...milestoneStates.values()]
      .sort(
        (a, b) => a.project.localeCompare(b.project) || a.id.localeCompare(b.id)
      )
      .map((milestone) => countMilestone(classified, milestone)),
    counts: projects.map((project) => countProject(classified, project)),
    anomalies: findAnomalies(snapshot, analysis, mixedEdges),
    cursors: snapshot.cursors,
    analysis,
  };
}

function partitionEdges(
  edges: readonly GraphEdge[],
  taskIds: ReadonlySet<string>,
  milestoneIds: ReadonlySet<string>
): {
  taskEdges: GraphEdge[];
  milestoneEdges: GraphEdge[];
  mixedEdges: GraphEdge[];
} {
  const taskEdges: GraphEdge[] = [];
  const milestoneEdges: GraphEdge[] = [];
  const mixedEdges: GraphEdge[] = [];

  for (const edge of edges) {
    const blockerM = milestoneIds.has(edge.blocker);
    const blockedM = milestoneIds.has(edge.blocked);
    const blockerT = taskIds.has(edge.blocker);
    const blockedT = taskIds.has(edge.blocked);

    if (blockerM && blockedM) milestoneEdges.push(edge);
    else if ((blockerM && blockedT) || (blockerT && blockedM))
      mixedEdges.push(edge);
    // An edge naming an unfetched id lands in taskEdges: the blocking walk reports
    // it as dangling and holds its dependent, which is the safe default.
    else taskEdges.push(edge);
  }

  return {taskEdges, milestoneEdges, mixedEdges};
}

function viewClaim(
  claim: Claim,
  nowMs: number,
  staleAfterMs: number
): ClaimView {
  const heartbeat = Date.parse(claim.heartbeatAt);
  // An unparseable heartbeat reads as live rather than silently freeing the task
  // — a corrupt timestamp should not hand someone else's work to another agent.
  const live = Number.isNaN(heartbeat) || nowMs - heartbeat <= staleAfterMs;
  return {agent: claim.agent, live, heartbeatAt: claim.heartbeatAt};
}

/**
 * Classification precedence, highest first:
 *
 *   verified/canceled → in-flight (started role, or a live claim) → dormant
 *   (backlog) → blocked → human-blocked → available
 *
 * A live claim outranks blocked/available: someone is on the task even if its
 * tracker role has not caught up. A `backlog` task is dormant whatever else is
 * true — it is not eligible to be picked up until a human promotes it.
 */
function classify(
  node: GraphNode,
  context: {
    blockedBy: string[];
    gatedBy: string[];
    claim: ClaimView | null;
    parked: ReadonlySet<Role>;
  }
): Classification {
  if (node.role === 'verified') return 'verified';
  if (node.role === 'canceled') return 'canceled';

  if (GROUP_OF[node.role] === 'started') return 'in-flight';
  if (context.claim?.live === true) return 'in-flight';

  if (node.role === 'backlog') return 'dormant';

  if (context.blockedBy.length > 0 || context.gatedBy.length > 0)
    return 'blocked';

  if (
    node.humanInteractive ||
    node.targetKind === 'human-only' ||
    context.parked.has(node.role)
  ) {
    return 'human-blocked';
  }

  return node.role === 'available' ? 'available' : 'dormant';
}

const OPEN: readonly Classification[] = [
  'available',
  'blocked',
  'human-blocked',
  'in-flight',
  'dormant',
];

function isTerminalProject(
  classified: readonly ClassifiedNode[],
  project: string
): boolean {
  return !classified.some(
    (entry) =>
      entry.node.project === project && OPEN.includes(entry.classification)
  );
}

function countProject(
  classified: readonly ClassifiedNode[],
  project: Project
): ProjectCounts {
  const own = classified.filter((entry) => entry.node.project === project.id);
  const tally = (kind: Classification): number =>
    own.filter((entry) => entry.classification === kind).length;

  return {
    project: project.id,
    partial: !project.declared,
    total: own.length,
    available: tally('available'),
    blocked: tally('blocked'),
    humanBlocked: tally('human-blocked'),
    inFlight: tally('in-flight'),
    dormant: tally('dormant'),
    verified: tally('verified'),
    canceled: tally('canceled'),
    terminal: project.declared && isTerminalProject(classified, project.id),
  };
}

function countMilestone(
  classified: readonly ClassifiedNode[],
  milestone: MilestoneState
): MilestoneCounts {
  const members = new Set(milestone.members);
  const own = classified.filter((entry) => members.has(entry.node.id));
  const tally = (kind: Classification): number =>
    own.filter((entry) => entry.classification === kind).length;

  return {
    ...milestone,
    available: tally('available'),
    blocked: tally('blocked'),
    humanBlocked: tally('human-blocked'),
    inFlight: tally('in-flight'),
    dormant: tally('dormant'),
    verified: tally('verified'),
    canceled: tally('canceled'),
  };
}

function findAnomalies(
  snapshot: GraphSnapshot,
  analysis: BlockingAnalysis,
  mixedEdges: readonly GraphEdge[]
): Anomaly[] {
  const anomalies: Anomaly[] = [];

  for (const cycle of analysis.cycles) {
    anomalies.push({
      kind: 'cycle',
      nodes: cycle,
      detail: `dependency cycle: ${cycle.join(' -> ')} -> ${cycle[0] ?? ''}`,
    });
  }

  const known = new Set(snapshot.nodes.map((node) => node.id));
  for (const edge of analysis.danglingEdges) {
    anomalies.push({
      kind: 'dangling-edge',
      nodes: [edge.blocker, edge.blocked],
      detail: known.has(edge.blocker)
        ? `${edge.blocker} blocks ${edge.blocked}, which is not in the graph; the edge schedules nothing — add ${edge.blocked} if it is in scope`
        : `blocker ${edge.blocker} of ${edge.blocked} is not in the graph; ${edge.blocked} is held blocked until ${edge.blocker} is added`,
    });
  }

  for (const edge of mixedEdges) {
    anomalies.push({
      kind: 'task-milestone-edge',
      nodes: [edge.blocker, edge.blocked],
      detail: `edge ${edge.blocker} -> ${edge.blocked} joins a task and a milestone; sequence milestones with milestone edges and attach a task with --milestone instead`,
    });
  }

  const knownMilestones = new Set(snapshot.milestones.map((m) => m.id));
  const orphans = new Map<string, string[]>();
  for (const node of snapshot.nodes) {
    if (node.milestone === null || knownMilestones.has(node.milestone))
      continue;
    const bucket = orphans.get(node.milestone);
    if (bucket === undefined) orphans.set(node.milestone, [node.id]);
    else bucket.push(node.id);
  }
  for (const [milestone, members] of orphans) {
    anomalies.push({
      kind: 'unknown-milestone',
      nodes: members.sort(),
      detail: `milestone ${milestone} is not in the graph, so its gate cannot be evaluated; ${String(members.length)} task(s) in it are NOT gated on any milestone — add it`,
    });
  }

  anomalies.push(...crossProjectReverse(snapshot));
  return anomalies;
}

function crossProjectReverse(snapshot: GraphSnapshot): Anomaly[] {
  const projectOf = new Map(
    snapshot.nodes.map((node) => [node.id, node.project])
  );
  const key = (from: string, to: string): string => JSON.stringify([from, to]);

  const pairs = new Map<
    string,
    {from: string; to: string; edges: GraphEdge[]}
  >();
  for (const edge of snapshot.edges) {
    const from = projectOf.get(edge.blocker);
    const to = projectOf.get(edge.blocked);
    if (from === undefined || to === undefined || from === to) continue;
    const bucket = pairs.get(key(from, to));
    if (bucket === undefined)
      pairs.set(key(from, to), {from, to, edges: [edge]});
    else bucket.edges.push(edge);
  }

  const anomalies: Anomaly[] = [];
  const reported = new Set<string>();
  for (const {from, to, edges} of pairs.values()) {
    const reverse = pairs.get(key(to, from));
    if (reverse === undefined) continue;
    const [left = '', right = ''] = [from, to].sort();
    const pairKey = key(left, right);
    if (reported.has(pairKey)) continue;
    reported.add(pairKey);

    const involved = [...edges, ...reverse.edges].flatMap((e) => [
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

function withInferredProjects(snapshot: GraphSnapshot): Project[] {
  const projects = [...snapshot.projects];
  const seen = new Set(projects.map((project) => project.id));

  for (const item of [...snapshot.nodes, ...snapshot.milestones]) {
    if (item.project === '' || seen.has(item.project)) continue;
    seen.add(item.project);
    projects.push({id: item.project, name: item.project, declared: false});
  }

  return projects;
}
