import {discover} from './lib/command/index.mts';
import {runCli} from './lib/cli/index.mts';
import {createLogger, streamSink} from './lib/logger/index.mts';

const tree = await discover(new URL('./commands/', import.meta.url));

// Diagnostics go to stderr on every path, because one of them is `dispatch mcp`:
// it serves JSON-RPC on stdout, and the default `console` sink would put
// `log`/`info`/`debug` into that stream. Command output rides `io`, not the
// logger, so nothing a caller reads moves.
process.exitCode = await runCli({
  argv: process.argv.slice(2),
  tree,
  log: createLogger(streamSink(process.stderr)),
  env: process.env,
  stdout: process.stdout,
  stderr: process.stderr,
});
