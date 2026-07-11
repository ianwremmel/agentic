/**
 * Shapes shared by the project-graph producer.
 *
 * Two serializations, deliberately different:
 *
 * - **XML** for anything an agent reads — the delta an adapter emits and the
 *   document the orchestrator consumes.
 * - **JSON** for the durable cache, which only these scripts ever touch.
 */

/** A ticket's role, from the protocol's vocabulary — never a tracker substate. */
export type Role =
  | 'backlog'
  | 'available'
  | 'in-progress'
  | 'in-review'
  | 'finished'
  | 'delivered'
  | 'verified'
  | 'canceled'
  | 'paused'
  | 'awaiting-external';

export type TargetKind = 'pr' | 'verification' | 'human-only';

/** Roles that end a ticket's life. A blocker in one of these no longer blocks. */
export const TERMINAL: ReadonlySet<string> = new Set(['verified', 'canceled']);

/** Roles that mean "stopped". Parked work is never dispatched. */
export const PARKED: ReadonlySet<string> = new Set(['paused', 'awaiting-external']);

/** Sorts after every explicitly-prioritized ticket and before nothing. */
export const DEFAULT_PRIORITY = 100;

export interface Project {
  id: string;
  name?: string;
  removed?: boolean;
}

export interface Milestone {
  id: string;
  project?: string;
  name?: string;
  /** Sequence within its project. Drives the review gate and ranking. */
  order?: number;
  /**
   * A review recorded since the milestone last gained a ticket. Scoped to the
   * current ready-for-review episode: a review that files follow-ups is older
   * than them, so this returns to false and the re-review runs.
   */
  review_recorded?: boolean;
  removed?: boolean;
}

export interface Node {
  id: string;
  url?: string;
  /** One line. The orchestrator prints it; it never reads the ticket body. */
  title?: string;
  /** Absent only on a `removed` node, which carries nothing but its id. */
  role?: Role;
  group?: string;
  project?: string;
  milestone?: string;
  target_kind?: TargetKind;
  /** From the configured tracker signal (a label or field). */
  human_interactive?: boolean;
  /**
   * Terminated without `verified` and will not progress. A *canceled* ticket is
   * not dead — cancellation unblocks its dependents.
   */
  dead?: boolean;
  priority?: number;
  labels?: string[];
  branch_hint?: string;
  /** PRs already known for this ticket, so a status table can link them. */
  pr_urls?: string[];
  removed?: boolean;
}

/** `blocker` blocks `blocked`: `blocked` cannot start until `blocker` is terminal. */
export interface Edge {
  blocker: string;
  blocked: string;
  removed?: boolean;
}

/** The durable normalized graph. JSON on disk; only these scripts read it. */
export interface Graph {
  cursor: string | null;
  projects: Project[];
  milestones: Milestone[];
  nodes: Node[];
  edges: Edge[];
}

/** One fetch from a tracker adapter. XML on the wire. */
export interface Delta {
  /** Replace the cache wholesale rather than merging into it. */
  full?: boolean;
  cursor?: string | null;
  projects?: Project[];
  milestones?: Milestone[];
  nodes?: Node[];
  edges?: Edge[];
  /**
   * Node ids whose edge set this delta restates in full. Cached edges touching
   * them are dropped before the delta's are applied, so a dependency deleted in
   * the tracker cannot survive in the cache. Omit it and edges are additive.
   */
  edges_for?: string[];
}

/** A node as it lives in the cache: a real ticket, so it has a role. */
export interface CachedNode extends Node {
  role: Role;
}

/** A node plus everything `derive` worked out about it. */
export interface DerivedNode extends CachedNode {
  blocked_by: string[];
  effective_blocked: boolean;
  milestone_gate: string | null;
  permanently_blocked: boolean;
  human_blocked: boolean;
  /** How many tickets this one transitively unblocks. Ranks the frontier. */
  unlocks: number;
}

export interface Counts {
  total: number;
  verified: number;
  canceled: number;
  permanently_blocked: number;
  remaining: number;
  /** Nothing workable is left. The orchestrator's completion test. */
  terminal: boolean;
}

export type Anomaly =
  | {kind: 'cycle'; nodes: string[]}
  | {kind: 'cross-project-cycle'; projects: string[]}
  | {kind: 'unknown-blocker'; node: string; blockers: string[]}
  | {kind: 'unknown-milestone'; node: string; milestone: string};

export interface DerivedMilestone {
  id: string;
  project: string;
  name?: string;
  order: number;
  ready_for_review: boolean;
  review_recorded: boolean;
  counts: Counts;
}

/** What the orchestrator reads. It consumes the derived sections, not the nodes. */
export interface Document {
  cursor: string | null;
  projects: Array<Project & {counts: Counts}>;
  milestones: DerivedMilestone[];
  nodes: DerivedNode[];
  /** Ranked ids eligible for dispatch. */
  available: string[];
  blocked: string[];
  human_blocked: string[];
  permanently_blocked: string[];
  /**
   * Workable, not in flight, and in no other section — `backlog` or `paused`.
   * Nothing will dispatch these, and they hold `remaining` above zero, so an idle
   * orchestrator names them instead of reporting "nothing to do".
   */
  stalled: string[];
  counts: Counts;
  anomalies: Anomaly[];
}
