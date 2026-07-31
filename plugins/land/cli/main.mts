import {EXIT_FAILURE, LandError} from './lib/errors.mts';
import {writeLine} from './lib/io.mts';
import {run} from './run.mts';

/**
 * Process entry point. Invoked by `bin/pr-status`, which guarantees a Node new
 * enough to run these `.mts` sources without a build step.
 *
 * stdout carries the pr-status XML; stderr carries logfmt records and, for a
 * failure, plain `error:`/`hint:` lines meant for whoever (or whatever) ran us.
 */
try {
  process.exitCode = await run(process.argv.slice(2), {
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
  });
} catch (error) {
  if (error instanceof LandError) {
    // An anticipated failure: toString() says what happened and the hint says
    // what to do, so a stack trace would only bury both.
    await writeLine(process.stderr, `error: ${error.toString()}`);
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
      'hint: this is a bug in the land pr-status CLI — report it with the stack above.'
    );
    process.exitCode = EXIT_FAILURE;
  }
}
