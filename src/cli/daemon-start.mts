// CLI handler for `dispatch daemon start`.
//
// This module owns all the real-world wiring needed to call
// `runDaemonStart`: it builds the dependency bag from real
// implementations (pid-lock, child_process, TaskStore, EventSpool,
// PollScheduler, etc.) and then delegates to the orchestrator.
//
// The handler is deliberately small: every step is a function
// pointer so the orchestrator can stay 100% unit-testable.
//
// Several wiring points are intentionally minimal placeholders for
// follow-up issues:
//
//   - `reattachWatches`: depends on a per-source watch factory
//     registry (#43 provides the manager; the factory wiring is
//     tracked separately). For now, the handler logs a notice and
//     no-ops. Recovery still synthesizes the daemon-restart events,
//     so the runner sees the correct context when the next
//     scheduler tick triggers a follow-up spawn.
//
//   - `startPollingLoop`: instantiates a PollScheduler and seeds it
//     with every rehydrated task. The per-tick `dispatch.tick`
//     callback is a placeholder that emits a log line; the real
//     callback (which routes through event-source pollers) is
//     covered by later command issues.
//
//   - `detach`: today's implementation only `process.unref()`s
//     stdin so the process can survive its parent. True
//     double-fork daemonization is tracked separately; until then
//     operators should run `dispatch daemon start --foreground`
//     under a process supervisor.

import { spawn } from "node:child_process";

import { DispatchError, ExitCode } from "./errors.mts";
import type { CommandHandler } from "./types.mts";
import { loadConfig } from "../config/index.mts";
import { EventSpool } from "../state/event-spool.mts";
import { ensureStateLayout } from "../state/paths.mts";
import { openTaskStore } from "../state/task-store.mts";
import { acquirePidLock } from "../daemon/pid-lock.mts";
import { PollScheduler } from "../daemon/poll-scheduler.mts";
import { buildBaseProbes, type CliProbe, type ProbeRunner } from "../daemon/preflight.mts";
import { runDaemonStart } from "../daemon/start.mts";
import { startIpcServer } from "../daemon/ipc.mts";
import type { DaemonStatusSnapshot } from "../daemon/status.mts";

/** Default probe runner: spawn argv[0] argv[1..]; capture exit code. */
function defaultProbeRunner(): ProbeRunner {
  return (probe: CliProbe) =>
    new Promise((resolve) => {
      try {
        const child = spawn(probe.argv[0]!, probe.argv.slice(1), {
          stdio: "ignore",
        });
        child.once("error", (err) => {
          const code = (err as NodeJS.ErrnoException).code;
          resolve({
            exitCode: -1,
            reason: code === "ENOENT" ? "command not found" : err.message,
          });
        });
        child.once("exit", (code) => {
          resolve({ exitCode: code ?? -1 });
        });
      } catch (err) {
        resolve({
          exitCode: -1,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    });
}

export const daemonStart: CommandHandler = async (parsed, ctx) => {
  const foreground = parsed.flags.foreground === true;

  const layout = ensureStateLayout({});
  const cfg = loadConfig();

  const probes = buildBaseProbes({
    runnerBin: cfg.runner.binary,
    // The CI/tracker CLI names are not part of DispatchConfig yet
    // (they're indirected through provider tokens in #23). When that
    // mapping lands, derive these from cfg.ci / cfg.trackers. Until
    // then, only the unconditional probes are run.
    ciCli: null,
    trackerCli: null,
  });

  const taskStore = openTaskStore({ root: layout.root });
  const eventSpool = new EventSpool({ root: layout.root });

  // PollScheduler is instantiated lazily so it only exists once
  // preflight passes. The tick callback is a placeholder; see file
  // header.
  let scheduler: PollScheduler | null = null;

  try {
    const report = await runDaemonStart(
      {
        acquireLock: () => acquirePidLock({ pidFile: layout.pidFile }),
        probes,
        runProbe: defaultProbeRunner(),
        recovery: { taskStore, eventSpool },
        reattachWatches: async (taskIds) => {
          ctx.stderr.write(
            `dispatch: daemon start: reattach-watches stub — ${taskIds.length} task(s) need watches\n`,
          );
        },
        startPollingLoop: () => {
          scheduler = new PollScheduler({
            tick: async (_taskId) => {
              // Placeholder; see file header for follow-up.
            },
          });
          // Seed the scheduler with every known task so the polling
          // cadence is active immediately. Fire-and-forget; new tasks
          // created later are armed by the runner-spawn wiring.
          void taskStore.list().then((tasks) => {
            for (const t of tasks) scheduler?.setTask(t);
          });
          // Start the IPC status server. Errors here surface to the
          // orchestrator's catch block, which releases the PID lock.
          void startIpcServer({
            sockFile: layout.sockFile,
            getStatus: async (): Promise<DaemonStatusSnapshot> => {
              const tasks = await taskStore.list();
              return {
                tasks,
                counters: {
                  eventsHandled: 0,
                  runnersSpawned: 0,
                  watchHandlesAlive: 0,
                  pendingFollowups: tasks.filter(
                    (t) =>
                      t.pending_followup !== null && t.pending_followup !== undefined,
                  ).length,
                },
              };
            },
          });
        },
        detach: () => {
          // Best-effort terminal detach for now (see file header).
          try {
            process.stdin.unref?.();
          } catch {
            /* ignore */
          }
        },
      },
      { foreground },
    );

    ctx.stdout.write(
      `dispatch daemon started (foreground=${foreground}, tasks=${report.recovery.tasks}, replayed=${report.recovery.replayedEvents.length}, restarts=${report.recovery.synthesizedRestarts.length})\n`,
    );

    // In --foreground mode we keep the process alive until the
    // scheduler is stopped (typically by `dispatch daemon stop` or a
    // SIGTERM handler installed by the pid-lock cleanup). When
    // detached, returning is correct — the event loop stays alive on
    // the scheduler's timers.
  } catch (err) {
    if (err instanceof DispatchError) throw err;
    throw new DispatchError(
      ExitCode.GENERIC,
      err instanceof Error ? err.message : String(err),
      "daemon start",
    );
  }
};
