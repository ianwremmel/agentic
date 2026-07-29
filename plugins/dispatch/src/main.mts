import {discover} from './lib/command/index.mts';
import {runCli} from './lib/cli/index.mts';
import {createLogger} from './lib/logger/index.mts';

const tree = await discover(new URL('./commands/', import.meta.url));

process.exitCode = await runCli({
  argv: process.argv.slice(2),
  tree,
  log: createLogger(),
  env: process.env,
  stdout: process.stdout,
  stderr: process.stderr,
});
