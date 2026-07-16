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
 * Split `[globals] <command> [command args]` at the command name.
 *
 * The command owns its own flags, so the global parse must stop at the command
 * and hand the rest over untouched. That requires the *position* of the command
 * name, which `values`/`positionals` don't carry — `positionals` is just a list
 * of strings, and searching argv for the first one is wrong whenever an option
 * value happens to equal it (`--log-level greet greet`). `tokens` reports the
 * index each token came from, which is the only thing here that answers "where
 * does the command start".
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
 * Options that only mean anything before the command. `--help` is deliberately
 * not one of them: after a command it asks for *that command's* usage.
 */
const GLOBAL_ONLY_OPTIONS = Object.keys(GLOBAL_OPTIONS).filter(
  (name) => name !== 'help'
);

/** Everything up to `--`; past it, a token is the command's literal payload. */
function beforeTerminator(argv: readonly string[]): readonly string[] {
  const terminator = argv.indexOf('--');
  return terminator === -1 ? argv : argv.slice(0, terminator);
}

/** Global-only options that appear after the command, where they no longer apply. */
export function misplacedGlobalOptions(
  commandArgs: readonly string[]
): string[] {
  const searched = beforeTerminator(commandArgs);

  return GLOBAL_ONLY_OPTIONS.map((name) => `--${name}`).filter((flag) =>
    searched.some((arg) => arg === flag || arg.startsWith(`${flag}=`))
  );
}

/** Whether the command args ask for the command's own usage. */
export function requestsHelp(commandArgs: readonly string[]): boolean {
  return beforeTerminator(commandArgs).some(
    (arg) => arg === '--help' || arg === '-h'
  );
}

/**
 * `parseArgs`, with bad input surfaced as a usage error. `parseArgs` reports an
 * unknown flag or a missing option value by throwing `ERR_PARSE_ARGS_*`, which
 * would otherwise reach the caller as a crash with a stack trace. Anything else
 * (a malformed config, i.e. our bug) propagates untouched.
 */
export function parseArgsOrUsage<T extends ParseArgsConfig>(
  config: T
): ReturnType<typeof parseArgs<T>> {
  try {
    return parseArgs(config);
  } catch (error) {
    if (!(error instanceof Error)) {
      throw new Error('parseArgs threw a non-Error value', {cause: error});
    }

    const code: unknown = 'code' in error ? error.code : undefined;
    if (typeof code === 'string' && code.startsWith('ERR_PARSE_ARGS_')) {
      throw new UsageError(error.message, {cause: error});
    }

    throw error;
  }
}
