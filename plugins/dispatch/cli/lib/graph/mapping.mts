import assert from 'node:assert';

import {DataError} from '../errors.mts';
import {isRole, ROLE_LIST, type Role} from './roles.mts';

/**
 * Native tracker state to protocol role (§2.3 per-tracker default mappings).
 *
 * Keys match case-insensitively. Resolution order is team override, then the
 * default table, then an error: §2.3 forbids guessing at an unmapped state,
 * because guessing wrong silently dispatches — or strands — real work.
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
      // Linear ships `duplicate` as a status type of its own. A duplicate is
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
 * Resolve one native state. `overrides` is the team's mapping from config, and
 * beats the tracker default.
 */
export function resolveRole(
  tracker: string,
  state: string,
  overrides: StateMapping = {}
): Role {
  const key = state.trim().toLowerCase();

  // The team override comes first, exactly as §2.3 orders it. Consulting the
  // tracker table first would mean a team that has mapped every one of its
  // states in config still could not use a tracker this CLI has no built-in
  // table for — and the override is precisely what should make that work.
  const override = lookup(overrides, key);
  if (override !== undefined) return override;

  const defaults = DEFAULT_MAPPINGS[tracker.toLowerCase()];
  assert(
    defaults !== undefined,
    new DataError(
      `no mapping for the native state "${state}": tracker "${tracker}" has no built-in table`,
      {
        hint: `map this tracker's states in the config file's "states" object, pass --tracker with one of: ${knownTrackers().join(', ')}, or give each node a resolved "role" in the payload.`,
      }
    )
  );

  const fallback = defaults[key];
  assert(
    fallback !== undefined,
    new DataError(
      `tracker "${tracker}" has no mapping for the native state "${state}"`,
      {
        hint: `add it to the config file's "states" object, mapping it to one of: ${ROLE_LIST}. Escalate to the operator if you cannot tell which role the state means — do not guess.`,
      }
    )
  );

  return fallback;
}

/** Case-insensitive lookup against a user-supplied (arbitrarily cased) mapping. */
function lookup(mapping: StateMapping, key: string): Role | undefined {
  for (const [state, role] of Object.entries(mapping)) {
    if (state.trim().toLowerCase() === key) return role;
  }
  return undefined;
}

/** Validate a config-supplied mapping before it can reach the graph. */
export function parseStateMapping(raw: unknown, source: string): StateMapping {
  if (raw === undefined || raw === null) return {};

  assert(
    typeof raw === 'object' && !Array.isArray(raw),
    new DataError(
      `${source}: "states" must be an object of native-state to role`,
      {
        hint: 'fix the config so "states" looks like {"Ready for QA": "in-review"}.',
      }
    )
  );

  const out: Record<string, Role> = {};
  for (const [state, role] of Object.entries(raw as Record<string, unknown>)) {
    assert(
      typeof role === 'string' && isRole(role),
      new DataError(
        `${source}: "${state}" maps to ${JSON.stringify(role)}, which is not a protocol role`,
        {hint: `use one of: ${ROLE_LIST}.`}
      )
    );
    out[state] = role;
  }

  return out;
}
