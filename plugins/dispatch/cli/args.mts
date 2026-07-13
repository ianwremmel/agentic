import {parseArgs, type ParseArgsConfig} from 'node:util';

import {UsageError} from './errors.mts';

/** Options understood before the command name. Also declared to the splitter so `--log-level info` consumes its value instead of looking like the command. */
export const GLOBAL_OPTIONS = {
  help: {type: 'boolean', short: 'h'},
  'log-level': {type: 'string'},
} as const satisfies NonNullable<ParseArgsConfig['options']>;

export interface SplitArgv {
  /** Tokens before the command name. */
  readonly globalArgs: string[];
  /** The command name, or `undefined` when none was given. */
  readonly command: string | undefined;
  /** Everything after the command name, verbatim — the command parses it itself. */
  readonly commandArgs: string[];
}

/**
 * Split `[globals] <command> [command args]` at the first positional.
 *
 * The command owns its own flags, so global parsing must stop at the command
 * name; `parseArgs` in token mode reports where that name sits without
 * interpreting anything after it.
 */
export function splitArgv(argv: readonly string[]): SplitArgv {
  const {tokens} = parseArgs({
    args: [...argv],
    options: GLOBAL_OPTIONS,
    allowPositionals: true,
    strict: false,
    tokens: true,
  });

  const command = tokens.find((token) => token.kind === 'positional');
  if (command === undefined) {
    return {globalArgs: [...argv], command: undefined, commandArgs: []};
  }

  return {
    globalArgs: argv.slice(0, command.index),
    command: command.value,
    commandArgs: argv.slice(command.index + 1),
  };
}

/**
 * `parseArgs`, with bad input surfaced as a usage error. `parseArgs` reports an
 * unknown flag or a missing option value by throwing `ERR_PARSE_ARGS_*`, which
 * would otherwise reach the caller as a crash with a stack trace. Anything else
 * (a malformed config, i.e. our bug) propagates untouched.
 */
export function parseArgsOrUsage<T extends ParseArgsConfig>(
  config: T,
): ReturnType<typeof parseArgs<T>> {
  try {
    return parseArgs(config);
  } catch (error) {
    const {code} = error as NodeJS.ErrnoException;
    if (typeof code === 'string' && code.startsWith('ERR_PARSE_ARGS_')) {
      throw new UsageError((error as Error).message);
    }
    throw error;
  }
}
