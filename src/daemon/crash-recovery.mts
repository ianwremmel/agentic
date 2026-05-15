// Crash recovery per
// `docs/spec/03-cli/01-daemon/02-normative.md` §Crash recovery.
//
// On startup, the daemon MUST:
//
//   1. Rehydrate all tasks from `tasks/`.
//   2. Replay queued events from `events/` oldest-first.
//   3. For every task whose `live_runner_pid` is set, synthesize
//      a `daemon-restart` event and queue it immediately.
//   4. Re-attach watch subprocesses / SDK handles for tasks with
//      active subscriptions.
//
// Step 4 (re-attach) is a side-effect performed by the daemon's
// runtime — it depends on the WatchManager (#43) and the subscription
// list on each task record. This module is responsible for steps 1-3.
//
// The `daemon-restart` event payload includes the original
// `live_runner_pid` and last-known stage, so the runner has context
// about what was interrupted. After the event is queued, the task
// record is updated to clear `live_runner_pid` (the runner is gone;
// the new instance will set it again when it spawns).

import type { EventSpool } from "../state/event-spool.mts";
import type { DispatchEvent } from "../state/event.mts";
import type { TaskRecord } from "../state/task-record.mts";
import type { TaskStore } from "../state/task-store.mts";

export interface CrashRecoveryDeps {
  /** Persistent task store (already pointed at the state root). */
  taskStore: Pick<TaskStore, "list" | "write">;
  /** Persistent event spool (already pointed at the state root). */
  eventSpool: Pick<EventSpool, "enqueue" | "drain">;
  /** RFC 3339 UTC timestamp generator; tests inject a fixed clock. */
  now?: () => string;
}

export interface CrashRecoveryReport {
  /** Number of TaskRecords found on disk. */
  tasks: number;
  /** Events replayed in chronological order. */
  replayedEvents: DispatchEvent[];
  /** Synthesized daemon-restart events that were queued. */
  synthesizedRestarts: DispatchEvent[];
  /** Task IDs whose subscriptions need re-attaching by the caller. */
  taskIdsToReattach: string[];
}

/**
 * Rehydrate state, replay events, and synthesize `daemon-restart`
 * events for any task that had a live runner at crash time.
 *
 * Returns a report so the caller (the daemon entrypoint) can
 * drive subsequent work — most importantly, the set of task IDs
 * whose `subscriptions` array is non-empty and therefore need
 * watch handles re-attached (step 4 in §Crash recovery).
 */
export async function recoverFromCrash(
  deps: CrashRecoveryDeps,
): Promise<CrashRecoveryReport> {
  const now = deps.now ?? defaultNow;

  const tasks = await deps.taskStore.list();

  // Replay queued events oldest-first. EventSpool.drain() already
  // sorts by filename (timestamp-prefixed), so the returned array
  // is already in chronological order.
  const drained = await deps.eventSpool.drain();
  const replayedEvents = drained.map((s) => s.event);

  // Synthesize daemon-restart for every task with live_runner_pid.
  const synthesizedRestarts: DispatchEvent[] = [];
  for (const task of tasks) {
    if (task.live_runner_pid === null || task.live_runner_pid === undefined) {
      continue;
    }
    const lastKnownStage = readLastKnownStage(task);
    const event: DispatchEvent = {
      kind: "daemon-restart",
      task_id: task.id,
      timestamp: now(),
      payload: {
        live_runner_pid: task.live_runner_pid,
        last_known_stage: lastKnownStage,
      },
    };
    await deps.eventSpool.enqueue(event);
    synthesizedRestarts.push(event);

    // Clear live_runner_pid; the runner is gone. The new instance
    // sets it again on the next spawn.
    const cleared: TaskRecord = { ...task, live_runner_pid: null };
    await deps.taskStore.write(cleared);
  }

  const taskIdsToReattach = tasks
    .filter((t) => Array.isArray(t.subscriptions) && t.subscriptions.length > 0)
    .map((t) => t.id);

  return {
    tasks: tasks.length,
    replayedEvents,
    synthesizedRestarts,
    taskIdsToReattach,
  };
}

function defaultNow(): string {
  return new Date().toISOString();
}

/**
 * Best-effort extraction of a last-known stage hint from the task
 * record. We don't define a strict shape here because §Crash
 * recovery only requires "last-known stage" as a hint to the
 * runner — it's allowed to be `null` if unknown.
 */
function readLastKnownStage(task: TaskRecord): string | null {
  const v = (task as { last_known_stage?: unknown }).last_known_stage;
  return typeof v === "string" ? v : null;
}
