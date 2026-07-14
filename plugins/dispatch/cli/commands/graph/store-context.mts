import type {ParseArgsConfig} from 'node:util';

import type {CommandContext} from '../../lib/command.mts';
import {
  loadConfig,
  resolveDbPath,
  type GraphConfig,
} from '../../lib/graph/config.mts';
import {GraphStore} from '../../lib/graph/store.mts';

/** Flags every graph command accepts: which graph, and how to read the tracker. */
export const STORE_OPTIONS = {
  db: {type: 'string'},
  config: {type: 'string'},
} as const satisfies NonNullable<ParseArgsConfig['options']>;

export const STORE_USAGE =
  '  --db <path>      Graph database (default: $DISPATCH_GRAPH_DB, else $XDG_STATE_HOME/dispatch/graph.db).\n' +
  '  --config <path>  Graph config (default: $DISPATCH_GRAPH_CONFIG, else ./.dispatch/graph.json if present).';

export interface StoreFlags {
  readonly db?: string | undefined;
  readonly config?: string | undefined;
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
