import {createLogger} from '../logger/index.mts';
import type {CoreLogger} from '../logger/index.mts';
import type {AbstractCommand} from './abstract-command.mts';
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
 */
export async function runCommand(
  command: AbstractCommand,
  raw: Record<string, string | boolean>,
  env: NodeJS.ProcessEnv
): Promise<string> {
  const parsed = parseOptions(command.options, raw);
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
