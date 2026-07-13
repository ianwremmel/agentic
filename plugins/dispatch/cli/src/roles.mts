/**
 * The protocol's role/group vocabulary. Tracker-neutral: adapters map native
 * states onto these, and every downstream reasoning step speaks only these.
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
 * The roles that stop a ticket from blocking its dependents. A `canceled`
 * ancestor *unblocks* downstream work rather than permanently blocking it, so
 * it belongs here alongside `verified`.
 */
export const RESOLVED_ROLES: ReadonlySet<Role> = new Set<Role>([
  'verified',
  'canceled',
]);

export function isResolved(role: Role): boolean {
  return RESOLVED_ROLES.has(role);
}

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

export const TARGET_KINDS = ['pr', 'verification', 'human-only'] as const;
export type TargetKind = (typeof TARGET_KINDS)[number];

export function isTargetKind(value: string): value is TargetKind {
  return (TARGET_KINDS as readonly string[]).includes(value);
}

export const EXCLUSION_KINDS = ['in-flight', 'done', 'failed'] as const;
export type ExclusionKind = (typeof EXCLUSION_KINDS)[number];

export function isExclusionKind(value: string): value is ExclusionKind {
  return (EXCLUSION_KINDS as readonly string[]).includes(value);
}
