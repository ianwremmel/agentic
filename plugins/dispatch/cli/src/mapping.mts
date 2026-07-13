import assert from 'node:assert';

import { DataError } from './errors.mts';
import { isRole, type Role } from './roles.mts';

/**
 * Native tracker state → protocol role.
 *
 * Keys are matched case-insensitively. Resolution order is team override →
 * default mapping → error: an unmapped state is never guessed at, because
 * guessing wrong silently dispatches (or strands) real work.
 */
export type StateMapping = Readonly<Record<string, Role>>;

export const DEFAULT_MAPPINGS: Readonly<Record<string, StateMapping>> =
  Object.freeze({
    linear: {
      backlog: 'backlog',
      todo: 'available',
      'in progress': 'in-progress',
      'in review': 'in-review',
      finished: 'finished',
      delivered: 'delivered',
      done: 'verified',
      canceled: 'canceled',
      // Linear exposes `duplicate` as a status type of its own. A duplicate is
      // abandoned work that will not be done, which is the `canceled` role.
      duplicate: 'canceled',
    },
    github: {
      backlog: 'backlog',
      paused: 'paused',
      blocked: 'awaiting-external',
      available: 'available',
      'in progress': 'in-progress',
      'in review': 'in-review',
      finished: 'finished',
      delivered: 'delivered',
      done: 'verified',
      canceled: 'canceled',
    },
    asana: {
      backlogged: 'backlog',
      paused: 'paused',
      blocked: 'awaiting-external',
      committed: 'available',
      'in progress': 'in-progress',
      'in review': 'in-review',
      complete: 'verified',
    },
  });

export function knownTrackers(): string[] {
  return Object.keys(DEFAULT_MAPPINGS);
}

/**
 * Resolve one native state. `overrides` is the team's mapping from config and
 * wins over the tracker default.
 */
export function resolveRole(
  tracker: string,
  state: string,
  overrides: StateMapping = {},
): Role {
  const defaults = DEFAULT_MAPPINGS[tracker.toLowerCase()];
  assert(
    defaults !== undefined,
    new DataError(
      `unknown tracker "${tracker}"`,
      `pass --tracker with one of: ${knownTrackers().join(', ')}, or supply every node's role directly in the payload.`,
    ),
  );

  const key = state.trim().toLowerCase();
  const override = lookup(overrides, key);
  if (override !== undefined) return override;

  const fallback = defaults[key];
  assert(
    fallback !== undefined,
    new DataError(
      `tracker "${tracker}" has no mapping for the native state "${state}"`,
      `add it to the config file's "states" object, mapping it to one of: backlog, paused, ` +
        `awaiting-external, available, in-progress, in-review, finished, delivered, verified, canceled. ` +
        `Escalate to the operator if you cannot tell which role the state means — do not guess.`,
    ),
  );

  return fallback;
}

/** Case-insensitive lookup against a user-supplied (arbitrarily cased) mapping. */
function lookup(mapping: StateMapping, key: string): Role | undefined {
  for (const [name, role] of Object.entries(mapping)) {
    if (name.trim().toLowerCase() === key) return role;
  }
  return undefined;
}

/** Validate a config-supplied mapping before it reaches the graph. */
export function parseStateMapping(raw: unknown, source: string): StateMapping {
  if (raw === undefined || raw === null) return {};
  assert(
    typeof raw === 'object' && !Array.isArray(raw),
    new DataError(
      `${source}: "states" must be an object of native-state → role`,
      'fix the config file so "states" looks like {"Ready for QA": "in-review"}.',
    ),
  );

  const out: Record<string, Role> = {};
  for (const [state, role] of Object.entries(raw as Record<string, unknown>)) {
    assert(
      typeof role === 'string' && isRole(role),
      new DataError(
        `${source}: "${state}" maps to ${JSON.stringify(role)}, which is not a protocol role`,
        'use one of: backlog, paused, awaiting-external, available, in-progress, in-review, finished, delivered, verified, canceled.',
      ),
    );
    out[state] = role;
  }
  return out;
}
