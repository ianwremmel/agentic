import {Readable, type Writable} from 'node:stream';

import {
  GLOBAL_OPTIONS,
  misplacedGlobalOptions,
  parseArgsOrUsage,
  requestsHelp,
  splitArgv,
} from './lib/args.mts';
import {assertUsage, EXIT_OK, UsageError} from './lib/errors.mts';
import {writeLine} from './lib/io.mts';
import {createLogger, resolveLogLevel} from './lib/log/logger.mts';
import {findCommand, helpText} from './lib/registry.mts';

export interface RunOptions {
  readonly stdout: Writable;
  readonly stderr: Writable;
  /**
   * Payload input for the commands that read one. Defaults to an empty stream:
   * most commands take none, and a test that drives one should not have to
   * fabricate a stdin it never uses.
   */
  readonly stdin?: NodeJS.ReadableStream;
  readonly env: NodeJS.ProcessEnv;
  readonly now?: () => Date;
}

/**
 * Parse `argv`, then run the named command. Returns the exit code; throws
 * {@link UsageError} for bad input and lets genuine failures propagate.
 */
export async function run(
  argv: readonly string[],
  {stdout, stderr, stdin, env, now}: RunOptions
): Promise<number> {
  const {globalArgs, command, commandArgs} = splitArgv(argv);

  const {values} = parseArgsOrUsage({
    args: globalArgs,
    options: GLOBAL_OPTIONS,
    allowPositionals: false,
    strict: true,
  });

  const level = resolveLogLevel(values['log-level'] ?? env.DISPATCH_LOG_LEVEL);
  const log = createLogger({stream: stderr, level, ...(now ? {now} : {})});

  await log.debug('parsed argv', {
    command: command ?? '-',
    argc: commandArgs.length,
  });

  if (values.help === true) {
    await writeLine(stdout, helpText());
    return EXIT_OK;
  }

  assertUsage(command !== undefined, `no command given\n\n${helpText()}`);

  const target = findCommand(command);
  assertUsage(
    target !== undefined,
    `unknown command "${command}"\n\n${helpText()}`
  );

  if (requestsHelp(commandArgs) && target.handlesHelp !== true) {
    await writeLine(stdout, `usage: ${target.usage}`);
    return EXIT_OK;
  }

  await log.info('running command', {command: target.name});
  const started = Date.now();

  try {
    await target.run(commandArgs, {
      stdout,
      stderr,
      stdin: stdin ?? Readable.from([]),
      log,
      env,
    });
  } catch (error) {
    if (!(error instanceof UsageError)) {
      throw error;
    }

    // A command's own usage error prints that command's usage, not the CLI's —
    // and for a subcommand, the group has already tagged the error with the
    // subcommand's usage, which is the one the caller actually needs.
    // A global option written after the command reaches the command as an
    // unknown flag, so name the real problem rather than let it read as a typo.
    const misplaced = misplacedGlobalOptions(commandArgs);
    const note =
      misplaced.length === 0
        ? ''
        : `\n\nnote: ${misplaced.join(', ')} — a global option must come before the command: dispatch ${misplaced.join(' ')} ... ${target.name} ...`;

    throw new UsageError(`${error.message}${note}`, {
      cause: error,
      usage: error.usage ?? target.usage,
      ...(error.hint === undefined ? {} : {hint: error.hint}),
    });
  }

  await log.info('command complete', {
    command: target.name,
    duration_ms: Date.now() - started,
  });

  return EXIT_OK;
}
