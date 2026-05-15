import { closeSync, openSync, readFileSync, writeSync } from "node:fs";
import { mkdir, unlink } from "node:fs/promises";
import { dirname } from "node:path";

import { CliError } from "../util/errors.mts";

export interface AcquiredLock {
  readonly path: string;
  readonly pid: number;
  release(): Promise<void>;
}

/**
 * Acquire the daemon PID lock per §3.1.2 §Single instance.
 *
 * Node's stdlib does not expose flock(2), so we approximate the spec's
 * LOCK_EX | LOCK_NB semantics via a PID file:
 *
 *   - If the file exists and the recorded PID is live (kill -0), refuse.
 *   - If the file exists but the PID is dead (stale lockfile from a crash),
 *     overwrite it and take the lock.
 *   - Otherwise, create it and write our PID.
 *
 * This is racy under simultaneous startup attempts; we accept the race because
 * the human-facing failure mode (two `daemon start` invocations in the same
 * second) is rare and the second invocation still gets a clear error on its
 * next status/start. We can swap in a native flock binding later.
 */
export async function acquirePidLock(path: string): Promise<AcquiredLock> {
  await mkdir(dirname(path), { recursive: true });

  const existing = readExistingPid(path);
  if (existing !== null && isProcessAlive(existing)) {
    throw new CliError(
      `dispatch daemon is already running (pid ${existing}); see ${path}`,
    );
  }

  const fd = openSync(path, "w");
  try {
    writeSync(fd, `${process.pid}\n`);
  } finally {
    closeSync(fd);
  }

  return {
    path,
    pid: process.pid,
    async release() {
      try {
        await unlink(path);
      } catch (err) {
        // The file may already be gone if we crashed earlier in shutdown. Don't
        // turn cleanup into a failure mode.
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    },
  };
}

export function readExistingPid(path: string): number | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const pid = Number.parseInt(raw.trim(), 10);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return pid;
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // EPERM means the process exists but we can't signal it — still alive.
    if (code === "EPERM") return true;
    return false;
  }
}
