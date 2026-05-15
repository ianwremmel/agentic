import { statSync } from "node:fs";

import { parseFlags } from "../cli/parse-args.mts";
import { isProcessAlive, readExistingPid } from "../daemon/pidlock.mts";
import { statePaths } from "../daemon/state-dir.mts";
import { CliError } from "../util/errors.mts";

export async function daemonStatus(argv: string[]): Promise<number> {
  parseFlags(argv, {});

  const paths = statePaths();
  const pid = readExistingPid(paths.pidFile);
  if (pid === null || !isProcessAlive(pid)) {
    throw new CliError("dispatch daemon is not running");
  }

  // §3.2.2 §daemon status calls for one line per task plus daemon-wide
  // counters. Until tasks and the event system exist, emit just the header.
  let started: string | null = null;
  try {
    started = statSync(paths.pidFile).mtime.toISOString();
  } catch {
    // ignore — non-fatal, the pid is still informative on its own
  }

  process.stdout.write(`pid          ${pid}\n`);
  if (started) process.stdout.write(`started      ${started}\n`);
  process.stdout.write(`state-dir    ${paths.root}\n`);
  process.stdout.write(`tasks        0\n`);
  process.stdout.write(`runners      0/4\n`);
  return 0;
}
