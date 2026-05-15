// CLI handler for `dispatch daemon stop [--force]`.
//
// Reads the pidFile from the resolved state layout, then delegates
// to `runDaemonStop` with real signal/sleep wiring.

import { setTimeout as sleep } from "node:timers/promises";
import { readFileSync } from "node:fs";

import { DispatchError, ExitCode } from "./errors.mts";
import type { CommandHandler } from "./types.mts";
import { ensureStateLayout } from "../state/paths.mts";
import { runDaemonStop } from "../daemon/stop.mts";

function readPidFile(path: string): number | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const n = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    // EPERM means the process exists but is owned by someone else.
    if (code === "EPERM") return true;
    throw err;
  }
}

export const daemonStop: CommandHandler = async (parsed, ctx) => {
  const force = parsed.flags.force === true;
  const layout = ensureStateLayout({});

  try {
    const report = await runDaemonStop(
      {
        readPidFile: () => readPidFile(layout.pidFile),
        processExists,
        sendSignal: (pid, signal) => {
          process.kill(pid, signal);
        },
        sleep: (ms) => sleep(ms),
      },
      { force },
    );
    ctx.stdout.write(
      `dispatch daemon stopped (pid=${report.pid}, exited=${report.exited}, forced=${report.forced}, waitedMs=${report.waitedMs})\n`,
    );
  } catch (err) {
    if (err instanceof DispatchError) throw err;
    throw new DispatchError(
      ExitCode.GENERIC,
      err instanceof Error ? err.message : String(err),
      "daemon stop",
    );
  }
};
