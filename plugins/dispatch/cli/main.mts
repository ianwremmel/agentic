import {DispatchError, EXIT_FAILURE} from './lib/errors.mts';
import {writeLine} from './lib/io.mts';
import {run} from './run.mts';

/**
 * Process entry point. Invoked by `bin/dispatch`, which guarantees a Node new
 * enough to run these `.mts` sources without a build step.
 *
 * stdout carries command output; stderr carries logfmt records and, for a
 * failure, plain `error:`/`hint:` lines meant for whoever (or whatever) ran us.
 */
try {
  process.exitCode = await run(process.argv.slice(2), {
    stdout: process.stdout,
    stderr: process.stderr,
    stdin: process.stdin,
    env: process.env,
  });
} catch (error) {
  if (error instanceof DispatchError) {
    // An anticipated failure: the message says what happened and the hint says
    // what to do, so a stack trace would only bury both.
    await writeLine(process.stderr, `error: ${error.message}`);
    if (error.hint !== undefined) {
      await writeLine(process.stderr, `hint: ${error.hint}`);
    }
    process.exitCode = error.exitCode;
  } else {
    // Anything else is a bug in the CLI. The caller cannot fix it, so give the
    // stack to whoever will.
    const detail =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
    await writeLine(process.stderr, `error: ${detail}`);
    await writeLine(
      process.stderr,
      'hint: this is a bug in the dispatch CLI — report it with the stack above.'
    );
    process.exitCode = EXIT_FAILURE;
  }
}
