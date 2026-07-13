import type {Writable} from 'node:stream';

import {GLOBAL_OPTIONS, parseArgsOrUsage, splitArgv} from './args.mts';
import {assertUsage, EXIT_OK, UsageError} from './errors.mts';
import {writeLine} from './io.mts';
import {createLogger, resolveLogLevel} from './log/logger.mts';
import {findCommand, helpText} from './registry.mts';

export interface RunOptions {
  readonly stdout: Writable;
  readonly stderr: Writable;
  readonly env: NodeJS.ProcessEnv;
  readonly now?: () => Date;
}

/**
 * Parse `argv`, then run the named command. Returns the exit code; throws
 * {@link UsageError} for bad input and lets genuine failures propagate.
 */
export async function run(
  argv: readonly string[],
  {stdout, stderr, env, now}: RunOptions,
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
    level,
  });

  if (values.help === true) {
    await writeLine(stdout, helpText());
    return EXIT_OK;
  }

  assertUsage(command !== undefined, `no command given\n\n${helpText()}`);

  const target = findCommand(command);
  assertUsage(
    target !== undefined,
    `unknown command "${command}"\n\n${helpText()}`,
  );

  await log.info('running command', {command: target.name});
  const started = Date.now();

  try {
    await target.run(commandArgs, {stdout, stderr, log, env});
  } catch (error) {
    // A command's own usage error should print that command's usage, not the CLI's.
    throw error instanceof UsageError
      ? new UsageError(`${error.message}\n\nusage: ${target.usage}`)
      : error;
  }

  await log.info('command complete', {
    command: target.name,
    duration_ms: Date.now() - started,
  });

  return EXIT_OK;
}
