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
  /** Injected at run time; ranks to the top of the available frontier (§2.6). */
  injected: boolean;
  /** Lower is more urgent. `null` sorts last — see `rank.mts`. */
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

export interface Project {
  id: string;
  name: string;
  /**
   * False when the project was never declared, only named by a task or milestone
   * — typically a cross-project ancestor pulled in to complete the dependency
   * closure. Its set is partial, so its counts describe only what happened to be
   * fetched and say nothing about whether the project is done.
   */
  declared: boolean;
}

/**
 * An agent's claim on a task. `agent` is its session id; `heartbeatAt` is when it
 * last proved liveness. A claim older than the staleness threshold is dead and
 * may be taken over (§2.6 lock reclamation).
 */
export interface Claim {
  id: string;
  agent: string;
  heartbeatAt: string;
}

/**
 * A recorded milestone review, pinned to the member set it reviewed. A review of
 * a different member set is not a review of this one.
 */
export interface ReviewRecord {
  milestone: string;
  fingerprint: string;
  recordedAt: string;
}

/** Everything the derivation needs, read from the store in one shot. */
export interface GraphSnapshot {
  projects: Project[];
  nodes: GraphNode[];
  edges: GraphEdge[];
  milestones: Milestone[];
  claims: Claim[];
  reviews: ReviewRecord[];
  cursors: Record<string, string>;
}
