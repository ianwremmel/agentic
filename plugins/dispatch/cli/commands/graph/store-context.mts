import assert from 'node:assert';
import type {ParseArgsConfig} from 'node:util';

import type {CommandContext} from '../../lib/command.mts';
import {UsageError} from '../../lib/errors.mts';
import {
  loadConfig,
  parseDuration,
  resolveDbPath,
  type GraphConfig,
} from '../../lib/graph/config.mts';
import {derive, type DeriveOptions} from '../../lib/graph/derive.mts';
import {GraphStore} from '../../lib/graph/store.mts';
import type {DerivedGraph} from '../../lib/graph/types.mts';

/** Flags every graph command accepts: which graph, and how to read the tracker. */
export const STORE_OPTIONS = {
  db: {type: 'string'},
  config: {type: 'string'},
} as const satisfies NonNullable<ParseArgsConfig['options']>;

export const STORE_USAGE =
  '  --db <path>      Graph database (default: $DISPATCH_GRAPH_DB, else $XDG_STATE_HOME/dispatch/graph.db).\n' +
  '  --config <path>  Graph config (default: $DISPATCH_GRAPH_CONFIG, else ./.dispatch/graph.json if present).';

export const STALE_AFTER_USAGE =
  '  --stale-after D  A claim not heartbeated within D (e.g. 10m, 30s, 2h) is treated\n' +
  "                   as dead. Default: the config's claimStaleAfter, else 10m.";

export interface StoreFlags {
  readonly db?: string | undefined;
  readonly config?: string | undefined;
}

/**
 * The claim-staleness window in ms: the `--stale-after` flag if given, else the
 * config default. A malformed flag is a usage error, not a silent fallback — a
 * caller that mistypes the window should hear about it, not get 10 minutes.
 */
export function resolveStaleAfterMs(
  flag: string | undefined,
  config: GraphConfig
): number {
  if (flag === undefined) return config.claimStaleAfterMs;
  const ms = parseDuration(flag);
  assert(
    ms !== null,
    new UsageError(`--stale-after is not a duration: "${flag}"`, {
      hint: 'use a number plus ms/s/m/h, e.g. --stale-after 10m.',
    })
  );
  return ms;
}

/**
 * Open the graph, run `body`, and close the graph even if `body` throws. Several
 * agents share one database, so a command that leaks its handle holds a lock the
 * next tick has to wait out.
 */
export async function withStore<T>(
  values: StoreFlags,
  {env}: Pick<CommandContext, 'env'>,
  body: (store: GraphStore, config: GraphConfig) => Promise<T>
): Promise<T> {
  const config = await loadConfig(values.config, env);
  const store = await GraphStore.open(resolveDbPath(values.db, env));

  try {
    return await body(store, config);
  } finally {
    await store.close();
  }
}

/** Derive the project-graph document from the store, honoring claim staleness. */
export function deriveGraph(
  store: GraphStore,
  config: GraphConfig,
  staleAfterMs: number
): DerivedGraph {
  return derive(store.database, {
    parkedRoles: config.parkedRoles,
    nowMs: Date.now(),
    staleAfterMs,
  });
}

/** The derive options a command's flags and config resolve to. */
export function deriveOptions(
  config: GraphConfig,
  staleAfterMs: number
): DeriveOptions {
  return {
    parkedRoles: config.parkedRoles,
    nowMs: Date.now(),
    staleAfterMs,
  };
}
