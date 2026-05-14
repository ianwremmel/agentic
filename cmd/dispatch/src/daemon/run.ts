import { mkdir } from "node:fs/promises";

import { openLogger, type DaemonLogger } from "./log.js";
import { acquirePidLock, type AcquiredLock } from "./pidlock.js";
import { statePaths, type StatePaths } from "./state-dir.js";

export interface RunDaemonOptions {
  foreground: boolean;
}

/**
 * Run the daemon process body. Returns when the daemon has shut down cleanly.
 *
 * Spec §3.1.2 §Lifecycle §Start enumerates eight steps. With no event sources
 * or runners wired up yet, we implement the subset that is meaningful today:
 *
 *   1. Acquire the PID lock.
 *   2. (skipped) Verify required CLIs — no spawn contract yet.
 *   3. (no-op) Rehydrate tasks — none to rehydrate.
 *   4. (no-op) Replay events — none queued.
 *   5. (no-op) Synthesize daemon-restart events.
 *   6. (no-op) Re-attach watch handles.
 *   7. Idle loop — wait for shutdown signal.
 *   8. Detach handled by the caller (daemon-start command).
 *
 * Steps 2-6 become real work once event sources land.
 */
export async function runDaemon(options: RunDaemonOptions): Promise<void> {
  const paths = statePaths();
  await ensureStateDirs(paths);

  const log = openLogger(paths.logFile, options.foreground);
  const lock = await acquirePidLock(paths.pidFile);

  log.info("daemon.start", {
    foreground: options.foreground,
    stateDir: paths.root,
    pid: lock.pid,
  });

  await runUntilShutdown(log);

  log.info("daemon.stop");
  await lock.release();
  await log.close();
}

async function ensureStateDirs(paths: StatePaths): Promise<void> {
  await mkdir(paths.root, { recursive: true });
  await mkdir(paths.tasksDir, { recursive: true });
  await mkdir(paths.eventsDir, { recursive: true });
}

function runUntilShutdown(log: DaemonLogger): Promise<void> {
  return new Promise((resolve) => {
    let shuttingDown = false;
    const shutdown = (signal: NodeJS.Signals) => {
      if (shuttingDown) return;
      shuttingDown = true;
      log.info("daemon.signal", { signal });
      clearInterval(heartbeat);
      process.off("SIGTERM", onTerm);
      process.off("SIGINT", onInt);
      resolve();
    };
    const onTerm = () => shutdown("SIGTERM");
    const onInt = () => shutdown("SIGINT");
    process.on("SIGTERM", onTerm);
    process.on("SIGINT", onInt);

    // A real heartbeat per §3.1.2 fires per-task; with no tasks the cadence is
    // only useful as a liveness signal in the log. Keep it cheap (10 min).
    // Crucially, this interval must stay ref'd: signal handlers do not keep
    // the Node event loop alive on their own, so without it the daemon would
    // exit immediately after start() returns.
    const heartbeat = setInterval(
      () => log.info("daemon.idle"),
      10 * 60 * 1000,
    );
  });
}
