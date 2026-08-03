import type {OutcomeKind, Status, TargetKind} from '../model/status.mts';

/**
 * §2.6-derived buckets, highest precedence first: resolved → in-flight →
 * dormant → blocked → human-blocked → available.
 */
export const CLASSIFICATIONS = [
  'verified',
  'canceled',
  'in-flight',
  'dormant',
  'blocked',
  'human-blocked',
  'available',
] as const;
export type Classification = (typeof CLASSIFICATIONS)[number];

/** A dispatch that continues earlier work rather than starting fresh. */
export const PASSES = ['resume', 'verify', 'finalize', 'retry'] as const;
export type Pass = (typeof PASSES)[number];

export interface DeriveOptions {
  /** RFC 3339 instant used for claim staleness; defaults to now. */
  now?: string | undefined;
  /** A session heartbeat older than this makes its claims stale. */
  staleAfterSeconds?: number | undefined;
  /** Restrict scheduling reads to one project (external id). */
  project?: string | undefined;
}

export interface ClaimView {
  session: string;
  live: boolean;
  actor: string | null;
  worktree: string | null;
  branch: string | null;
  claimedAt: string;
}

export interface OutcomeView {
  outcome: OutcomeKind;
  retryable: boolean | null;
  detail: string | null;
}

/** One dispatchable work item: a ticket, or a bare PR (no ticket attached). */
export interface WorkItem {
  id: string;
  kind: 'ticket' | 'pr';
  /** Null for a bare PR. */
  project: string | null;
  url: string | null;
  title: string;
  /** Null for a bare PR — its lifecycle is its outcome row. */
  status: Status | null;
  targetKind: TargetKind | null;
  requiresHuman: boolean;
  injected: boolean;
  priority: number | null;
  branchHint: string | null;
  labels: string[];
  milestones: string[];
}

export interface ClassifiedItem {
  item: WorkItem;
  classification: Classification;
  effectiveBlocked: boolean;
  /** Unresolved blocking ancestors, by external id. */
  blockedBy: string[];
  /** Milestones whose unfinished review gates this item, by external id. */
  gatedBy: string[];
  claim: ClaimView | null;
  outcome: OutcomeView | null;
  /** Transitive descendant count — how much work this item gates. */
  fanout: number;
}

export interface QueueEntry {
  entry: ClassifiedItem;
  /** Null for ordinary available work; otherwise the follow-up pass. */
  pass: Pass | null;
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
  /** Ready, reviewed, and no member carries an unresolved dependency. */
  open: boolean;
  claim: ClaimView | null;
}

export interface Anomaly {
  kind: 'cycle' | 'dangling-edge' | 'cross-project-reverse';
  nodes: string[];
  detail: string;
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
  total: number;
  terminal: boolean;
}

export interface DerivedGraph {
  projects: {id: string; name: string; terminal: boolean}[];
  items: ClassifiedItem[];
  milestones: MilestoneState[];
  counts: ProjectCounts[];
  /** Bare-PR work items, outside any project's counts. */
  prompt: ClassifiedItem[];
  anomalies: Anomaly[];
  /** Every selected project terminal and no bare-PR item open. */
  terminal: boolean;
}
