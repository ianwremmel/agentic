/**
 * The §2.3 role and group vocabulary. Tracker-neutral: adapters map native
 * states onto these, and every reasoning step downstream speaks only these.
 */

export const GROUPS = [
  'backlog',
  'unstarted',
  'started',
  'completed',
  'canceled',
] as const;
export type Group = (typeof GROUPS)[number];

export const ROLES = [
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
export type Role = (typeof ROLES)[number];

export const GROUP_OF: Readonly<Record<Role, Group>> = Object.freeze({
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

/**
 * The roles that stop a ticket blocking its dependents (§2.3 effective
 * blocking). `canceled` belongs here beside `verified`: abandoning a ticket
 * *releases* the work behind it rather than blocking it forever.
 */
export const RESOLVED_ROLES: ReadonlySet<Role> = new Set<Role>([
  'verified',
  'canceled',
]);

export function isResolved(role: Role): boolean {
  return RESOLVED_ROLES.has(role);
}

/** Roles that mean "parked pending a human". Tracker-dependent; configurable. */
export const DEFAULT_PARKED_ROLES: readonly Role[] = [
  'awaiting-external',
  'paused',
];

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

/** What working a ticket produces (§2.6): a PR, a no-PR verification, a human. */
export const TARGET_KINDS = ['pr', 'verification', 'human-only'] as const;
export type TargetKind = (typeof TARGET_KINDS)[number];

export function isTargetKind(value: string): value is TargetKind {
  return (TARGET_KINDS as readonly string[]).includes(value);
}

/** The roles, listed for an error message that has to say what is allowed. */
export const ROLE_LIST = ROLES.join(', ');
export const TARGET_KIND_LIST = TARGET_KINDS.join(', ');
