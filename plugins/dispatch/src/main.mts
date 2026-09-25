import {discover} from './lib/command/index.mts';
import {runCli} from './lib/cli/index.mts';
import {startTelemetry} from './lib/telemetry/index.mts';

const telemetry = await startTelemetry({stream: process.stderr});

// `discover` is inside the try so a discovery failure still reaches the flush.
// Nothing below calls `process.exit` and `runCli` catches without rethrowing,
// so the `finally` covers every path that unwinds. Signals and throws from
// unawaited callbacks do not unwind and are not covered — a SIGTERM'd `dispatch
// mcp` loses whatever the collector's batch processor was holding, along with
// the session row its own `finally` would have closed.
try {
  const tree = await discover(new URL('./commands/', import.meta.url));

  process.exitCode = await runCli({
    argv: process.argv.slice(2),
    tree,
    env: process.env,
    stdout: process.stdout,
    stderr: process.stderr,
  });
} finally {
  await telemetry.shutdown();
}
