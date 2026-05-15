// PID lock enforcing one daemon per machine per
// `docs/spec/03-cli/01-daemon/02-normative.md` §Single instance.
//
// Algorithm:
//
//   1. `open(pidFile, O_WRONLY|O_CREAT|O_EXCL, 0o644)` (the `wx` flag).
//      Succeeds → write our PID, return a release handle.
//   2. EEXIST → read the PID stored in the file:
//        a. if `kill -0` succeeds → another daemon is alive, refuse to
//           start (return `{ ok: false, holderPid }`).
//        b. if `kill -0` throws ESRCH → stale lockfile, unlink and
//           retry step 1 exactly once.
//        c. if `kill -0` throws EPERM → a *different* process owns that
//           PID. We can't kill it, but it isn't us; treat as held.
//      A second EEXIST after stale recovery means we lost a race with
//      another starting daemon; treat as held with the new PID.
//   3. The release handle:
//        - unlinks the file (best-effort) when invoked.
//        - is invoked from `process.on("exit")` and from SIGTERM /
//          SIGINT handlers so that the lockfile never outlives the
//          process for a clean shutdown or signal exit.
//
// We deliberately do not pull in a native `flock(2)` binding. The
// exclusive-create + PID-validation pattern is the canonical Node
// idiom and matches the spec's intent: refuse to start when a live
// daemon exists; recover from stale files.

import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";

export interface AcquireOptions {
  pidFile: string;
  /** Defaults to `process.pid`. */
  pid?: number;
  /**
   * Probe whether a PID is alive. Defaults to `process.kill(pid, 0)`.
   * Exposed for tests.
   */
  isAlive?: (pid: number) => boolean;
  /**
   * Hook for signal/exit registration. Defaults to wiring on the real
   * `process`. Tests override this to assert what gets registered
   * without actually mutating the global process.
   */
  registerCleanup?: (release: () => void) => void;
}

export type AcquireResult =
  | { ok: true; release: () => void; pidFile: string }
  | { ok: false; reason: "held"; holderPid: number };

export function acquirePidLock(opts: AcquireOptions): AcquireResult {
  const pid = opts.pid ?? process.pid;
  const isAlive = opts.isAlive ?? defaultIsAlive;
  const register = opts.registerCleanup ?? defaultRegisterCleanup;

  mkdirSync(dirname(opts.pidFile), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt++) {
    const fd = tryExclusiveCreate(opts.pidFile);
    if (fd !== "exists") {
      writeSync(fd, `${pid}\n`);
      closeSync(fd);
      const release = makeRelease(opts.pidFile);
      register(release);
      return { ok: true, release, pidFile: opts.pidFile };
    }
    // EEXIST path: inspect holder.
    const holder = readHolderPid(opts.pidFile);
    if (holder !== null && isAlive(holder)) {
      return { ok: false, reason: "held", holderPid: holder };
    }
    // Either the file vanished (holder===null via ENOENT), contained
    // garbage (holder===null via parse failure), or held a dead PID.
    // All three are recoverable: unlink (best effort) and retry.
    try {
      unlinkSync(opts.pidFile);
    } catch {
      // Another process may have already cleaned it up; loop and retry.
    }
  }
  // Two consecutive EEXIST results from a *live* holder on the second
  // pass means we lost the race to another starter. Re-read to report
  // the winning PID.
  const winner = readHolderPid(opts.pidFile) ?? -1;
  return { ok: false, reason: "held", holderPid: winner };
}

function tryExclusiveCreate(path: string): number | "exists" {
  try {
    return openSync(path, "wx", 0o644);
  } catch (err: unknown) {
    if (isNodeError(err) && err.code === "EEXIST") return "exists";
    throw err;
  }
}

function readHolderPid(path: string): number | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err: unknown) {
    if (isNodeError(err) && err.code === "ENOENT") return null;
    throw err;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const n = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    if (isNodeError(err)) {
      if (err.code === "ESRCH") return false;
      // EPERM means a process exists but isn't ours to signal — treat
      // as alive so we never steal someone else's PID.
      if (err.code === "EPERM") return true;
    }
    throw err;
  }
}

function defaultRegisterCleanup(release: () => void): void {
  let released = false;
  const once = () => {
    if (released) return;
    released = true;
    release();
  };
  process.on("exit", once);
  process.on("SIGTERM", () => {
    once();
    process.exit(143);
  });
  process.on("SIGINT", () => {
    once();
    process.exit(130);
  });
}

function makeRelease(path: string): () => void {
  return () => {
    try {
      unlinkSync(path);
    } catch (err: unknown) {
      if (isNodeError(err) && err.code === "ENOENT") return;
      // Anything else: swallow. Release runs in `exit` listeners and
      // signal handlers; throwing there is worse than a leaked file.
    }
  };
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return typeof err === "object" && err !== null && "code" in err;
}

/** Exit code returned to the shell when another daemon is running. */
export const EXIT_HELD = 4;
