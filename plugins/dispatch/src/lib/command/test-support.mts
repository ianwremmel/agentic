import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

import {createLogger} from '../logger/index.mts';
import type {CoreLogger} from '../logger/index.mts';
import type {Ticket} from '../model/index.mts';
import type {AbstractCommand} from './abstract-command.mts';
import {assertEnv} from './env.mts';
import {parseOptions} from './parse.mts';

/* eslint-disable @typescript-eslint/no-empty-function --
 * A logger that discards every call, so a test's output only ever reflects `io`. */
const SILENT: CoreLogger = {
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
  trace: () => {},
  log: () => {},
};
/* eslint-enable @typescript-eslint/no-empty-function */

/**
 * Run a command the way a transport would, and return what it wrote to `io`.
 * `raw` goes through `parseOptions`, so defaults and `choices` apply exactly as
 * they would from argv or JSON — pass every value as a string except booleans.
 * Also runs `assertEnv` before `run`, matching both real transports (the cli
 * and the MCP server), so a command that declares required `env` fails here
 * the same way it would in production.
 */
export async function runCommand(
  command: AbstractCommand,
  raw: Record<string, string | boolean>,
  env: NodeJS.ProcessEnv
): Promise<string> {
  const parsed = parseOptions(command.options, raw);
  assertEnv(command.env, env);
  let captured = '';
  await command.run(parsed, {
    log: createLogger(SILENT),
    env,
    io: {
      write: (chunk) => {
        captured += chunk;
      },
    },
  });
  return captured;
}

/**
 * An environment pointing at a graph database of this test's own, in a fresh
 * temp directory. Commands resolve `--db` through `DISPATCH_DB`, so a test that
 * forgets this one writes the developer's real graph.
 */
export async function tempEnv(): Promise<NodeJS.ProcessEnv> {
  const dir = await mkdtemp(path.join(tmpdir(), 'dispatch-cmd-'));
  return {DISPATCH_DB: path.join(dir, 'graph.db')};
}

/**
 * A ticket whose every optional field is empty, so a test asserting on one of
 * them is asserting on something it set itself.
 */
export function ticket(id: string, project: string): Ticket {
  return {
    id,
    project,
    url: `https://example.test/${id}`,
    title: id,
    status: 'available',
    targetKind: 'pr',
    requiresHuman: false,
    injected: false,
    priority: null,
    branchHint: null,
    labels: [],
    updatedAt: null,
  };
}
