import {EXIT_FAILURE, EXIT_USAGE, UsageError} from './errors.mts';
import {writeLine} from './io.mts';
import {run} from './run.mts';

/**
 * Process entry point. Invoked by `bin/dispatch`, which guarantees a Node new
 * enough to run these `.mts` sources without a build step.
 *
 * stdout carries command output; stderr carries logfmt records and, for a
 * failure, a plain `error: ...` line meant for whoever (or whatever) ran us.
 */
try {
  process.exitCode = await run(process.argv.slice(2), {
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
  });
} catch (error) {
  if (error instanceof UsageError) {
    await writeLine(process.stderr, `error: ${error.message}`);
    process.exitCode = EXIT_USAGE;
  } else {
    const detail =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
    await writeLine(process.stderr, `error: ${detail}`);
    process.exitCode = EXIT_FAILURE;
  }
}
