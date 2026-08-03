import {homedir} from 'node:os';
import {join} from 'node:path';

import type {Option} from '../command/index.mts';
import {Database} from './database.mts';

/**
 * The `--db` flag every graph-writing command carries. Declared `as const
 * satisfies Option` rather than typed `Option`: `ParsedOptions` reads the
 * literal `type` to decide what `run` receives, and a widened type resolves to
 * `never`.
 */
export const DB_OPTION = {
  type: 'string',
  description:
    'Graph database path. Defaults to $DISPATCH_DB, else $XDG_STATE_HOME/dispatch/graph-v2.db.',
  positional: false,
  required: false,
} as const satisfies Option;

export function resolveDbPath(
  flag: string | undefined,
  env: NodeJS.ProcessEnv
): string {
  if (flag !== undefined && flag !== '') return flag;
  if (env.DISPATCH_DB !== undefined && env.DISPATCH_DB !== '')
    return env.DISPATCH_DB;
  const state =
    env.XDG_STATE_HOME !== undefined && env.XDG_STATE_HOME !== ''
      ? env.XDG_STATE_HOME
      : join(homedir(), '.local', 'state');
  // `graph-v2.db`, not `graph.db`: installations that ran the retired
  // `dispatch graph …` CLI still have a `graph.db` in this directory at an
  // incompatible schema, and `Database.open` refuses a file recorded at a
  // foreign version. The suffix names the CLI generation, not the schema
  // version.
  return join(state, 'dispatch', 'graph-v2.db');
}

/**
 * Open the graph, run `body`, and close it even if `body` throws. Several
 * agents share one file, so a command that leaks its handle holds a lock the
 * next one has to wait out.
 */
export async function withDatabase<T>(
  flag: string | undefined,
  env: NodeJS.ProcessEnv,
  body: (db: Database) => Promise<T> | T
): Promise<T> {
  const db = await Database.open(resolveDbPath(flag, env));
  try {
    return await body(db);
  } finally {
    await db.close();
  }
}
