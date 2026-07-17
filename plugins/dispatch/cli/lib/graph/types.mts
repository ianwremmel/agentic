import type {Role, TargetKind} from './roles.mts';

/** A task. `id` is the tracker's human identifier (e.g. `CLC-945`). */
export interface GraphNode {
  id: string;
  project: string;
  url: string;
  title: string;
  role: Role;
  milestone: string | null;
  targetKind: TargetKind;
  humanInteractive: boolean;
  /** Injected at run time; ranks to the top of the available frontier. */
  injected: boolean;
  /** Lower is more urgent. `null` sorts last. */
  priority: number | null;
  branchHint: string | null;
  labels: string[];
  updatedAt: string | null;
}

/** `blocker` blocks `blocked` — i.e. `blocked` depends on `blocker` (§2.3). */
export interface GraphEdge {
  blocker: string;
  blocked: string;
}

/**
 * A milestone. It carries no order: sequencing is expressed as edges between
 * milestones (`M1 blocks M2`), so a milestone can have several predecessors, the
 * same way a task can.
 */
export interface Milestone {
  id: string;
  project: string;
  name: string;
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
  /** Where the holder reports the work is checked out, if it has. */
  worktree: string | null;
  branch: string | null;
}

/** A coordinator's recorded final report on a node. */
export interface OutcomeView {
  outcome: string;
  /** Meaningful only for `failed`; null otherwise. */
  retryable: boolean | null;
  detail: string | null;
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
  /** The recorded outcome, if a coordinator reported one. */
  outcome: OutcomeView | null;
  /** Transitive descendant count — how much work resolving this would unblock. */
  fanout: number;
}

export interface Anomaly {
  kind:
    'cycle' | 'dangling-edge' | 'cross-project-reverse' | 'unknown-milestone';
  nodes: string[];
  detail: string;
}

export interface MilestoneState {
  id: string;
  project: string;
  name: string;
  members: string[];
  memberCount: number;
  openCount: number;
  readyForReview: boolean;
  reviewRecorded: boolean;
  /** The review agent's claim on this milestone, if any. */
  claim: ClaimView | null;
}

export interface ClassificationCounts {
  available: number;
  blocked: number;
  humanBlocked: number;
  inFlight: number;
  dormant: number;
  verified: number;
  canceled: number;
}

export interface ProjectCounts extends ClassificationCounts {
  project: string;
  partial: boolean;
  total: number;
  /** No task the orchestrator can act on, now or later. */
  terminal: boolean;
}

export interface MilestoneCounts extends MilestoneState, ClassificationCounts {}

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
}
