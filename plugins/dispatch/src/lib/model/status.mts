export const KINDS = [
  'project',
  'milestone',
  'ticket',
  'pr',
  'unknown',
] as const;
export type Kind = (typeof KINDS)[number];
export type ConcreteKind = Exclude<Kind, 'unknown'>;

export const STATUSES = [
  'backlog',
  'paused',
  'awaiting-external',
  'available',
  'in-progress',
  'in-review',
  'finished',
  'delivered',
  'verified',
  'canceled',
] as const;
export type Status = (typeof STATUSES)[number];

export const STATUS_GROUPS = [
  'backlog',
  'unstarted',
  'started',
  'completed',
  'canceled',
] as const;
export type StatusGroup = (typeof STATUS_GROUPS)[number];

export const GROUP_OF: Readonly<Record<Status, StatusGroup>> = Object.freeze({
  backlog: 'backlog',
  paused: 'backlog',
  'awaiting-external': 'backlog',
  available: 'unstarted',
  'in-progress': 'started',
  'in-review': 'started',
  finished: 'started',
  delivered: 'started',
  verified: 'completed',
  canceled: 'canceled',
});

/** Statuses that stop a ticket blocking its dependents (effective blocking). */
export const RESOLVED_STATUSES: ReadonlySet<Status> = new Set<Status>([
  'verified',
  'canceled',
]);

export function isStatus(value: string): value is Status {
  return (STATUSES as readonly string[]).includes(value);
}

export function isResolved(status: Status): boolean {
  return RESOLVED_STATUSES.has(status);
}

export const TARGET_KINDS = ['pr', 'verification', 'human-only'] as const;
export type TargetKind = (typeof TARGET_KINDS)[number];

export function isTargetKind(value: string): value is TargetKind {
  return (TARGET_KINDS as readonly string[]).includes(value);
}

export const PR_ORIGINS = ['prompt', 'ticket', 'adopted', 'resumed'] as const;
export type PrOrigin = (typeof PR_ORIGINS)[number];

export function isPrOrigin(value: string): value is PrOrigin {
  return (PR_ORIGINS as readonly string[]).includes(value);
}

export const OUTCOMES = [
  'verified',
  'canceled',
  'delivered',
  'human-blocked',
  'decomposed',
  'failed',
] as const;
export type OutcomeKind = (typeof OUTCOMES)[number];

export function isOutcome(value: string): value is OutcomeKind {
  return (OUTCOMES as readonly string[]).includes(value);
}

export const STATUS_LIST = STATUSES.join(', ');
export const TARGET_KIND_LIST = TARGET_KINDS.join(', ');
export const PR_ORIGIN_LIST = PR_ORIGINS.join(', ');
