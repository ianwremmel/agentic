import type {ExclusionKind, Role, TargetKind} from './roles.mts';

/** A ticket. `id` is the tracker's human identifier (e.g. `CLC-945`). */
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

export interface Milestone {
  id: string;
  project: string;
  name: string;
  /** Ascending order within its project. Decides which milestone gates which. */
  sortOrder: number;
}

export interface Project {
  id: string;
  name: string;
  /**
   * False when the project was never fetched, only named by a ticket — typically
   * a cross-project ancestor pulled in to complete the dependency closure. Its
   * ticket set is partial, so its counts describe only what happened to be
   * fetched and say nothing about whether the project is done.
   */
  declared: boolean;
}

export interface Exclusion {
  id: string;
  kind: ExclusionKind;
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
  exclusions: Exclusion[];
  reviews: ReviewRecord[];
  cursors: Record<string, string>;
}
