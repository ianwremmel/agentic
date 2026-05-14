import { setTimeout as delay } from "node:timers/promises";

import { parseFlags } from "../cli/parse-args.js";
import { isProcessAlive, readExistingPid } from "../daemon/pidlock.js";
import { statePaths } from "../daemon/state-dir.js";
import { CliError } from "../util/errors.js";

const FLAGS = {
  force: { type: "boolean" as const },
} satisfies Parameters<typeof parseFlags>[1];

const GRACE_PERIOD_MS = 30_000;

export async function daemonStop(argv: string[]): Promise<number> {
  const { values } = parseFlags(argv, FLAGS);
  const force = values.force === true;

  const paths = statePaths();
  const pid = readExistingPid(paths.pidFile);
  if (pid === null || !isProcessAlive(pid)) {
    throw new CliError("dispatch daemon is not running");
  }

  process.kill(pid, "SIGTERM");

  // §3.1.2 §Lifecycle §Stop says wait up to 30s for in-flight runners, then
  // SIGTERM remaining. We have no runners yet, so for now: wait for the
  // daemon process itself to exit. --force skips the wait entirely.
  if (force) {
    process.stdout.write(`dispatch daemon stop signalled (pid ${pid})\n`);
    return 0;
  }

  const deadline = Date.now() + GRACE_PERIOD_MS;
  while (Date.now() < deadline) {
    await delay(100);
    if (!isProcessAlive(pid)) {
      process.stdout.write(`dispatch daemon stopped (pid ${pid})\n`);
      return 0;
    }
  }

  // Grace expired — escalate. SIGTERM again is a no-op if the process is
  // wedged; without SIGKILL access on every platform, we surface the failure.
  throw new CliError(
    `dispatch daemon (pid ${pid}) did not exit within ${GRACE_PERIOD_MS / 1000}s; rerun with --force`,
  );
}
