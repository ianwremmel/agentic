import assert from 'node:assert';
import {readFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';

import {DataError, describeCause, EnvironmentError} from '../errors.mts';
import {parseStateMapping, type StateMapping} from './mapping.mts';
import {isRole, ROLE_LIST, type Role} from './roles.mts';
import {DEFAULT_PARKED_ROLES} from './derive.mts';

export interface GraphConfig {
  /** Team overrides for native state to protocol role (§2.3 team override). */
  states: StateMapping;
  /** Labels that mark a ticket as one only a human may work (§2.6). */
  humanInteractiveLabels: readonly string[];
  /** Labels that mark a ticket as a no-PR verification (§2.6 target-kind). */
  verificationLabels: readonly string[];
  /** Roles that mean "parked pending a human" on this tracker. */
  parkedRoles: readonly Role[];
  /** Default staleness for a claim (ms). Overridable per call by `--stale-after`. */
  claimStaleAfterMs: number;
}

/** Ten minutes: a claim not heartbeated within it is presumed dead (§2.6). */
export const DEFAULT_STALE_AFTER_MS = 10 * 60 * 1000;

export const DEFAULT_CONFIG: GraphConfig = Object.freeze({
  states: {},
  humanInteractiveLabels: ['human-only', 'needs-human'],
  verificationLabels: ['verification'],
  parkedRoles: DEFAULT_PARKED_ROLES,
  claimStaleAfterMs: DEFAULT_STALE_AFTER_MS,
});

/**
 * Parse a duration like `15m`, `30s`, `2h`, or a bare number of seconds, into ms.
 * Returns null on anything unrecognizable, so the caller can name the flag.
 */
export function parseDuration(value: string): number | null {
  const match = /^(\d+)(ms|s|m|h)?$/u.exec(value.trim());
  if (match === null) return null;
  const n = Number(match[1]);
  switch (match[2]) {
    case 'ms':
      return n;
    case 'h':
      return n * 60 * 60 * 1000;
    case 'm':
      return n * 60 * 1000;
    // A bare number is seconds, matching `s`.
    case 's':
    case undefined:
      return n * 1000;
    default:
      return null;
  }
}

/**
 * Where the durable graph lives. Precedence: the flag, then the environment,
 * then the XDG state directory — so a skill can hold several graphs apart (one
 * per orchestration run) without either of them having to know the layout.
 */
export function resolveDbPath(
  flag: string | undefined,
  env: NodeJS.ProcessEnv
): string {
  if (flag !== undefined && flag !== '') return flag;
  if (env.DISPATCH_GRAPH_DB !== undefined && env.DISPATCH_GRAPH_DB !== '') {
    return env.DISPATCH_GRAPH_DB;
  }

  const state =
    env.XDG_STATE_HOME !== undefined && env.XDG_STATE_HOME !== ''
      ? env.XDG_STATE_HOME
      : join(homedir(), '.local', 'state');

  return join(state, 'dispatch', 'graph.db');
}

/**
 * Load the graph config, or the defaults when there is none.
 *
 * A path given explicitly (by flag or environment) MUST exist: a caller that
 * names a config file and silently gets the defaults would ingest a whole
 * tracker under the wrong state mapping. The conventional path is optional.
 */
export async function loadConfig(
  flag: string | undefined,
  env: NodeJS.ProcessEnv
): Promise<GraphConfig> {
  const explicit =
    flag !== undefined && flag !== ''
      ? flag
      : env.DISPATCH_GRAPH_CONFIG !== undefined &&
          env.DISPATCH_GRAPH_CONFIG !== ''
        ? env.DISPATCH_GRAPH_CONFIG
        : undefined;

  const path = explicit ?? join(process.cwd(), '.dispatch', 'graph.json');

  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (cause) {
    if (explicit === undefined && isNotFound(cause)) return DEFAULT_CONFIG;

    throw new EnvironmentError(
      `cannot read the graph config at ${path}: ${describeCause(cause)}`,
      {
        hint: 'point --config at a readable JSON file, or omit it to use the built-in defaults.',
      }
    );
  }

  return parseConfig(raw, path);
}

export function parseConfig(raw: string, source: string): GraphConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new DataError(
      `${source} is not valid JSON: ${describeCause(cause)}`,
      {hint: 'fix the config file, or delete it to fall back to the defaults.'}
    );
  }

  assert(
    typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed),
    new DataError(`${source} must contain a JSON object`, {
      hint: 'the config looks like {"states": {...}, "humanInteractiveLabels": [...]}.',
    })
  );
  const doc = parsed as Record<string, unknown>;

  return {
    states: parseStateMapping(doc.states, source),
    humanInteractiveLabels:
      labels(doc.humanInteractiveLabels, 'humanInteractiveLabels', source) ??
      DEFAULT_CONFIG.humanInteractiveLabels,
    verificationLabels:
      labels(doc.verificationLabels, 'verificationLabels', source) ??
      DEFAULT_CONFIG.verificationLabels,
    parkedRoles: parkedRoles(doc.parkedRoles, source),
    claimStaleAfterMs: claimStaleAfter(doc.claimStaleAfter, source),
  };
}

function claimStaleAfter(raw: unknown, source: string): number {
  if (raw === undefined || raw === null)
    return DEFAULT_CONFIG.claimStaleAfterMs;

  assert(
    typeof raw === 'string',
    new DataError(`${source}: "claimStaleAfter" must be a duration string`, {
      hint: 'write it as {"claimStaleAfter": "10m"} — number plus ms/s/m/h.',
    })
  );

  const ms = parseDuration(raw);
  assert(
    ms !== null,
    new DataError(`${source}: "claimStaleAfter" is not a duration: "${raw}"`, {
      hint: 'use a number plus ms/s/m/h, e.g. "10m".',
    })
  );

  return ms;
}

function labels(
  raw: unknown,
  key: string,
  source: string
): readonly string[] | undefined {
  if (raw === undefined || raw === null) return undefined;

  assert(
    Array.isArray(raw) && raw.every((value) => typeof value === 'string'),
    new DataError(`${source}: "${key}" must be an array of strings`, {
      hint: `write it as {"${key}": ["needs-human"]}.`,
    })
  );

  return raw;
}

function parkedRoles(raw: unknown, source: string): readonly Role[] {
  if (raw === undefined || raw === null) return DEFAULT_CONFIG.parkedRoles;

  assert(
    Array.isArray(raw) && raw.every((value) => typeof value === 'string'),
    new DataError(`${source}: "parkedRoles" must be an array of strings`, {
      hint: `write it as {"parkedRoles": ["awaiting-external", "paused"]}.`,
    })
  );

  return raw.map((value) => {
    assert(
      isRole(value),
      new DataError(
        `${source}: "parkedRoles" names "${value}", which is not a protocol role`,
        {hint: `use one of: ${ROLE_LIST}.`}
      )
    );
    return value;
  });
}

function isNotFound(cause: unknown): boolean {
  return (
    typeof cause === 'object' &&
    cause !== null &&
    'code' in cause &&
    cause.code === 'ENOENT'
  );
}
