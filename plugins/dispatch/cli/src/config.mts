import assert from 'node:assert';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { EnvironmentError, UsageError } from './errors.mts';
import { parseStateMapping, type StateMapping } from './mapping.mts';
import { isRole, type Role } from './roles.mts';

export interface GraphConfig {
  /** Team overrides for native state → role. Beats the tracker default. */
  states: StateMapping;
  /** Labels that mean "a human must handle this ticket". */
  humanInteractiveLabels: string[];
  /** Labels that mean "no code change; run the named verification". */
  verificationLabels: string[];
  /** Roles that mean "parked pending a human". */
  parkedRoles: Role[];
}

export const DEFAULT_CONFIG: GraphConfig = {
  states: {},
  humanInteractiveLabels: ['human-led', 'human-interactive'],
  verificationLabels: ['verification'],
  parkedRoles: ['awaiting-external', 'paused'],
};

/**
 * Where the graph lives. Explicit flag wins, then the environment (the plugin
 * harness exports its config as CLAUDE_PLUGIN_OPTION_*), then the XDG cache.
 */
export function resolveDbPath(flag: string | undefined): string {
  const fromEnv =
    process.env.DISPATCH_GRAPH_DB ?? process.env.CLAUDE_PLUGIN_OPTION_GRAPH_DB;
  if (flag !== undefined && flag !== '') return resolve(expandHome(flag));
  if (fromEnv !== undefined && fromEnv !== '')
    return resolve(expandHome(fromEnv));

  const base =
    process.env.DISPATCH_CACHE_DIR ??
    process.env.XDG_CACHE_HOME ??
    join(homedir(), '.cache');
  return resolve(join(expandHome(base), 'dispatch', 'graph.sqlite'));
}

export async function loadConfig(
  path: string | undefined,
): Promise<GraphConfig> {
  const fromEnv = process.env.CLAUDE_PLUGIN_OPTION_GRAPH_CONFIG;
  const target = path ?? (fromEnv === '' ? undefined : fromEnv);
  if (target === undefined) return { ...DEFAULT_CONFIG };

  const full = resolve(expandHome(target));
  let raw: string;
  try {
    raw = await readFile(full, 'utf8');
  } catch (cause) {
    throw new EnvironmentError(
      `cannot read the graph config file at ${full}: ${describe(cause)}`,
      'check the path passed to --config (or the graph_config plugin option). Omit it to use the built-in defaults.',
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new UsageError(
      `the graph config file at ${full} is not valid JSON: ${describe(cause)}`,
      'fix the JSON syntax, then re-run.',
    );
  }

  assert(
    typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed),
    new UsageError(
      `the graph config file at ${full} must contain a JSON object`,
      'see the build-graph skill reference for the config shape.',
    ),
  );

  const record = parsed as Record<string, unknown>;
  return {
    states: parseStateMapping(record.states, full),
    humanInteractiveLabels: stringList(
      record.humanInteractiveLabels,
      DEFAULT_CONFIG.humanInteractiveLabels,
      `${full}: humanInteractiveLabels`,
    ),
    verificationLabels: stringList(
      record.verificationLabels,
      DEFAULT_CONFIG.verificationLabels,
      `${full}: verificationLabels`,
    ),
    parkedRoles: roleList(record.parkedRoles, DEFAULT_CONFIG.parkedRoles, full),
  };
}

function stringList(
  raw: unknown,
  fallback: string[],
  source: string,
): string[] {
  if (raw === undefined || raw === null) return [...fallback];
  assert(
    Array.isArray(raw) && raw.every((v) => typeof v === 'string'),
    new UsageError(
      `${source} must be an array of strings`,
      'fix the config file, e.g. ["human-led"].',
    ),
  );
  return raw;
}

function roleList(raw: unknown, fallback: Role[], source: string): Role[] {
  if (raw === undefined || raw === null) return [...fallback];
  assert(
    Array.isArray(raw) && raw.every((v) => typeof v === 'string' && isRole(v)),
    new UsageError(
      `${source}: parkedRoles must be an array of protocol roles`,
      'use roles such as ["awaiting-external", "paused"].',
    ),
  );
  return raw;
}

function expandHome(path: string): string {
  return path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
