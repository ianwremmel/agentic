import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

import { parseFlags } from "../cli/parse-args.js";
import { isProcessAlive, readExistingPid } from "../daemon/pidlock.js";
import { runDaemon } from "../daemon/run.js";
import { statePaths } from "../daemon/state-dir.js";
import { CliError } from "../util/errors.js";

const FLAGS = {
  foreground: { type: "boolean" as const },
  // Internal: marks the re-exec'd detached child. Not part of the public CLI.
  "__detached-child": { type: "boolean" as const },
} satisfies Parameters<typeof parseFlags>[1];

export async function daemonStart(argv: string[]): Promise<number> {
  const { values } = parseFlags(argv, FLAGS);
  const foreground = values.foreground === true;
  const detachedChild = values["__detached-child"] === true;

  if (foreground || detachedChild) {
    await runDaemon({ foreground });
    return 0;
  }

  return spawnDetached();
}

/**
 * Spawn ourselves as a detached background process and wait briefly for the
 * child to either acquire the PID lock (success) or exit (failure). The parent
 * stays alive only long enough to give the user a synchronous yes/no answer.
 */
async function spawnDetached(): Promise<number> {
  const paths = statePaths();
  const existingPid = readExistingPid(paths.pidFile);
  if (existingPid !== null && isProcessAlive(existingPid)) {
    throw new CliError(
      `dispatch daemon is already running (pid ${existingPid})`,
    );
  }

  // Re-exec ourselves. Forward execArgv (so loaders like tsx survive in dev)
  // and the original argv tail starting at the script path. Under SEA there
  // is no script in argv[1], so slice(1) yields just the subcommand tokens,
  // which is also correct.
  const argv = [...process.execArgv, ...process.argv.slice(1), "--__detached-child"];
  const child = spawn(process.execPath, argv, {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();

  // Poll the pidfile until it reflects the child's pid (or a sibling that
  // raced past us). Cap at 5s so a wedged child doesn't hang the parent.
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    await delay(100);
    const pid = readExistingPid(paths.pidFile);
    if (pid !== null && isProcessAlive(pid)) {
      readFileSync(paths.pidFile, "utf8"); // touch to surface FS errors early
      process.stdout.write(`dispatch daemon started (pid ${pid})\n`);
      return 0;
    }
    if (child.exitCode !== null) {
      throw new CliError(
        `dispatch daemon failed to start; see ${paths.logFile}`,
      );
    }
  }
  throw new CliError(
    `dispatch daemon did not acquire its PID lock within 5s; see ${paths.logFile}`,
  );
}
