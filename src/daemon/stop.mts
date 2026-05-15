// `dispatch daemon stop` orchestrator per
// `docs/spec/03-cli/01-daemon/02-normative.md` §Lifecycle §Stop.
//
// The CLI process is a *client* to the running daemon: it reads the
// pidFile to find the daemon, sends SIGTERM, and (unless `--force`)
// waits up to 30 seconds for it to exit. The daemon itself owns the
// graceful-shutdown steps (stop accepting events, await in-flight
// runners, persist state, release lock).
//
// `--force` skips the wait — the orchestrator returns immediately
// after sending SIGTERM, leaving the OS to deliver the signal and the
// daemon to clean up at its own pace (or to be torn down by a
// supervisor if it hangs).
//
// All side-effects (pidFile read, signal send, alive probe, sleep)
// are injected, so the orchestrator is unit-testable end-to-end.

import { DispatchError, ExitCode } from "../cli/errors.mts";

/** Default 30-second graceful-shutdown window. */
export const DEFAULT_STOP_TIMEOUT_MS = 30_000;
/** Default polling interval while waiting for exit. */
export const DEFAULT_STOP_POLL_MS = 100;

export interface DaemonStopDeps {
  /** Returns the daemon PID, or null if the pidFile is missing/empty. */
  readPidFile: () => number | null;
  /** Returns true if the given PID is currently alive. */
  processExists: (pid: number) => boolean;
  /** Sends the given signal to `pid`. Should be a thin wrapper over `process.kill`. */
  sendSignal: (pid: number, signal: "SIGTERM" | "SIGKILL") => void;
  /** Resolves after `ms` milliseconds. */
  sleep: (ms: number) => Promise<void>;
}

export interface DaemonStopOptions {
  force: boolean;
  /** Override the 30s wait. Defaults to `DEFAULT_STOP_TIMEOUT_MS`. */
  timeoutMs?: number;
  /** Override the 100ms poll. Defaults to `DEFAULT_STOP_POLL_MS`. */
  pollMs?: number;
}

export interface DaemonStopReport {
  /** PID that was signalled. */
  pid: number;
  /** True if the daemon process is gone by the time we returned. */
  exited: boolean;
  /** True if `--force` skipped the wait. */
  forced: boolean;
  /** How many milliseconds we waited for the daemon to exit. */
  waitedMs: number;
}

/**
 * Run the daemon-stop sequence. Throws `DispatchError` with the
 * spec-mandated exit code when there is no daemon to signal.
 */
export async function runDaemonStop(
  deps: DaemonStopDeps,
  opts: DaemonStopOptions,
): Promise<DaemonStopReport> {
  const pid = deps.readPidFile();
  if (pid === null) {
    throw new DispatchError(
      ExitCode.PRECONDITION,
      "no dispatch daemon is running (pidfile missing)",
      "daemon stop",
    );
  }
  if (!deps.processExists(pid)) {
    throw new DispatchError(
      ExitCode.PRECONDITION,
      `no dispatch daemon is running (stale pidfile referenced pid ${pid})`,
      "daemon stop",
    );
  }

  // Step 1 happens inside the daemon when it observes SIGTERM:
  // it stops accepting new events. The CLI just has to deliver the
  // signal.
  try {
    deps.sendSignal(pid, "SIGTERM");
  } catch (err) {
    throw new DispatchError(
      ExitCode.GENERIC,
      `failed to signal daemon (pid ${pid}): ${err instanceof Error ? err.message : String(err)}`,
      "daemon stop",
    );
  }

  if (opts.force) {
    // Step 2 is skipped. We do NOT poll; we report and return so a
    // caller can layer their own watchdog if desired.
    return { pid, exited: !deps.processExists(pid), forced: true, waitedMs: 0 };
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
  const pollMs = opts.pollMs ?? DEFAULT_STOP_POLL_MS;

  // Step 2. Wait up to `timeoutMs` for the daemon to exit on its own.
  let waitedMs = 0;
  while (waitedMs < timeoutMs) {
    if (!deps.processExists(pid)) {
      return { pid, exited: true, forced: false, waitedMs };
    }
    await deps.sleep(pollMs);
    waitedMs += pollMs;
  }

  // Final post-loop check; the process may have exited during the
  // last sleep.
  if (!deps.processExists(pid)) {
    return { pid, exited: true, forced: false, waitedMs };
  }

  // Daemon failed to shut down within the window. The spec doesn't
  // escalate to SIGKILL from the CLI side (that's the daemon's job
  // for its runner children). We report `exited: false` and a
  // non-zero exit so the caller knows the signal didn't take.
  throw new DispatchError(
    ExitCode.GENERIC,
    `dispatch daemon (pid ${pid}) did not exit within ${timeoutMs}ms of SIGTERM`,
    "daemon stop",
  );
}
