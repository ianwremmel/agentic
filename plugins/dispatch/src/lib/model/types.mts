import type {OutcomeKind, PrOrigin, Status, TargetKind} from './status.mts';

/** Every entity's `id` is its tracker/forge external id (e.g. `CLC-945`). */
export interface Project {
  id: string;
  name: string;
  /** The tracker this project came from; null until a write names one. */
  source: string | null;
}

export interface Milestone {
  id: string;
  project: string;
  name: string;
}

export interface Ticket {
  id: string;
  project: string;
  url: string;
  title: string;
  status: Status;
  targetKind: TargetKind;
  requiresHuman: boolean;
  /** Injected at run time; ranks to the top of the frontier. */
  injected: boolean;
  /** Lower is more urgent; `null` sorts last. */
  priority: number | null;
  branchHint: string | null;
  labels: string[];
  updatedAt: string | null;
}

export interface Pr {
  id: string;
  /** The originating ticket, or null for a bare PR / raw prompt. */
  ticket: string | null;
  origin: PrOrigin;
  repo: string | null;
  prNumber: number | null;
  url: string | null;
  branch: string | null;
  title: string;
  injected: boolean;
  priority: number | null;
  updatedAt: string | null;
}

/** `blocker` blocks `blocked` — i.e. `blocked` depends on `blocker`. */
export interface Edge {
  blocker: string;
  blocked: string;
}

export interface Session {
  id: string;
  host: string | null;
  pid: number | null;
  /** The Claude session this server serves; the caller correlator. */
  claudeSessionId: string | null;
  /** When the session acknowledged the probe; work orders wait on it. */
  ackedAt: string | null;
  startedAt: string;
  heartbeatAt: string;
}

export interface Claim {
  node: string;
  session: string;
  actor: string | null;
  worktree: string | null;
  branch: string | null;
  claimedAt: string;
}

export interface Outcome {
  node: string;
  outcome: OutcomeKind;
  /** Meaningful only for `failed`; null otherwise. */
  retryable: boolean | null;
  detail: string | null;
  recordedAt: string;
}
