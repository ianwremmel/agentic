import {discover} from './lib/command/index.mts';
import {runCli} from './lib/cli/index.mts';
import {createLogger, streamSink} from './lib/logger/index.mts';
import {flushOnExit, startTelemetry} from './lib/telemetry/index.mts';

const telemetry = await startTelemetry({stream: process.stderr});
const stopFlushingOnExit = flushOnExit(telemetry, process.stderr);

// `discover` runs inside the try so that a discovery failure still reaches the
// flush. The try is the whole flush story for the paths that unwind: there is
// no `process.exit` anywhere below it and `runCli` catches everything without
// rethrowing, so the `finally` covers the successful command, both error
// exits, and a broken installation alike. A discovery failure still ends the
// process with its stack and code 1, exactly as it did before — the only
// change is that telemetry is drained first. `flushOnExit` covers the paths
// that do not unwind: a signal, and a throw from a callback nothing awaits.
try {
  const tree = await discover(new URL('./commands/', import.meta.url));

  // Diagnostics go to stderr on every path, because one of them is `dispatch
  // mcp`: it serves JSON-RPC on stdout, and the default `console` sink would
  // put `log`/`info`/`debug` into that stream. Command output rides `io`, not
  // the logger, so nothing a caller reads moves.
  process.exitCode = await runCli({
    argv: process.argv.slice(2),
    tree,
    log: createLogger(streamSink(process.stderr)),
    env: process.env,
    stdout: process.stdout,
    stderr: process.stderr,
  });
} finally {
  // Shut down first, uninstall second. A signal arriving during this flush is
  // precisely what the handlers are for, and uninstalling them ahead of the
  // await would let it kill the process mid-export.
  await telemetry.shutdown();
  stopFlushingOnExit();
}
