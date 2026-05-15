// `dispatch daemon start` orchestrator per
// `docs/spec/03-cli/01-daemon/02-normative.md` §Lifecycle §Start.
//
// This module owns the *order* and the *invariants* of startup; it
// delegates every side-effect to an injected dependency so it is
// unit-testable end-to-end.
//
// The sequence (with the issue/sub-task that owns each step):
//
//   1. Acquire the daemon PID lock (#41).
//   2. Verify required CLIs (preflight; see preflight.mts).
//   3. Rehydrate tasks + replay queued events + synthesize
//      `daemon-restart` events for any task with a recorded live
//      runner PID (#47 — `recoverFromCrash`).
//   4. Re-attach watch handles for tasks reported by step 3 (#43).
//   5. Begin the polling loop (#42).
//   6. Detach from the terminal unless `--foreground`.
//
// Failure modes:
//
//   - PID lock held by a live process →
//       DispatchError(PRECONDITION, "another dispatch daemon is already running (pid <N>)")
//   - Any preflight failure →
//       DispatchError(PRECONDITION, "required CLI checks failed:\n<details>")
//   - Recovery/I/O errors propagate to the caller as plain Error.
//
// The function returns a structured report so the CLI layer (and
// tests) can verify each step ran. Side effects (polling, detach)
// are kicked off but not awaited; the orchestrator returns as soon
// as the daemon is "live".

import { DispatchError, ExitCode } from "../cli/errors.mts";
import {
  recoverFromCrash,
  type CrashRecoveryDeps,
  type CrashRecoveryReport,
} from "./crash-recovery.mts";
import {
  formatFailures,
  verifyRequiredClis,
  type CliProbe,
  type PreflightFailure,
  type ProbeRunner,
} from "./preflight.mts";

/**
 * Outcome shape of a PID lock acquisition. We accept anything that
 * looks like the result of `pid-lock.acquirePidLock` to avoid a hard
 * dependency on its concrete return type in tests.
 */
export type AcquireLockOutcome =
  | { ok: true; release: () => void; pidFile?: string }
  | { ok: false; reason: "held"; holderPid: number };

export interface DaemonStartDeps {
  /** Step 1. Synchronously attempts to acquire the daemon PID lock. */
  acquireLock: () => AcquireLockOutcome;
  /** Step 2. Probes to run; e.g. from `buildBaseProbes`. */
  probes: readonly CliProbe[];
  /** Step 2. Injected probe runner (exec-equivalent). */
  runProbe: ProbeRunner;
  /** Step 3. Crash-recovery deps (taskStore + eventSpool + now). */
  recovery: CrashRecoveryDeps;
  /**
   * Step 4. Called with the task IDs reported by recovery; should
   * idempotently start a watch subprocess per (task, source) pair.
   * Errors propagate.
   */
  reattachWatches: (taskIds: readonly string[]) => Promise<void>;
  /**
   * Step 5. Fire-and-forget; the orchestrator does NOT await this.
   * The function should return promptly after kicking off the loop.
   */
  startPollingLoop: () => void;
  /**
   * Step 6. Called only when `foreground` is false. Should detach the
   * process from the controlling terminal (e.g. double-fork on Unix).
   */
  detach: () => void;
}

export interface DaemonStartOptions {
  foreground: boolean;
}

export interface DaemonStartReport {
  /** Whether the daemon is now considered live. */
  ok: true;
  recovery: CrashRecoveryReport;
  detached: boolean;
  /** Release the PID lock. Caller invokes this on shutdown. */
  release: () => void;
}

/**
 * Run the daemon start sequence. Throws `DispatchError` with the
 * spec-mandated exit codes on lock contention or preflight failure.
 */
export async function runDaemonStart(
  deps: DaemonStartDeps,
  opts: DaemonStartOptions,
): Promise<DaemonStartReport> {
  // ---- 1. PID lock --------------------------------------------------
  const lock = deps.acquireLock();
  if (!lock.ok) {
    throw new DispatchError(
      ExitCode.PRECONDITION,
      `another dispatch daemon is already running (pid ${lock.holderPid})`,
      "daemon start",
    );
  }

  try {
    // ---- 2. Preflight -----------------------------------------------
    const pf = await verifyRequiredClis(deps.probes, deps.runProbe);
    if (!pf.ok) {
      throw new DispatchError(
        ExitCode.PRECONDITION,
        `required CLI checks failed:\n${formatFailures(pf.failures as PreflightFailure[])}`,
        "daemon start",
      );
    }

    // ---- 3. Recovery (rehydrate / replay / synth daemon-restart) ----
    const recovery = await recoverFromCrash(deps.recovery);

    // ---- 4. Re-attach watches --------------------------------------
    if (recovery.taskIdsToReattach.length > 0) {
      await deps.reattachWatches(recovery.taskIdsToReattach);
    }

    // ---- 5. Polling loop -------------------------------------------
    deps.startPollingLoop();

    // ---- 6. Detach -------------------------------------------------
    const detached = !opts.foreground;
    if (detached) deps.detach();

    return {
      ok: true,
      recovery,
      detached,
      release: lock.release,
    };
  } catch (err) {
    // Any failure after we acquired the lock must release it before
    // propagating. We don't want a stale lockfile blocking the next
    // start attempt.
    try {
      lock.release();
    } catch {
      // ignore — best-effort
    }
    throw err;
  }
}
