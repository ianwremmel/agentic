// Daemon status snapshot + TSV formatter per
// `docs/spec/03-cli/02-commands/02-normative.md` §`dispatch daemon status`.
//
// Output is deliberately TSV-stable: per-task lines first, then
// daemon-wide counters as `KEY<TAB>VALUE`. No headers, no JSON, no
// localized text — the spec calls for a machine-parseable format.

import type { TaskRecord } from "../state/task-record.mts";

export interface DaemonStatusCounters {
  eventsHandled: number;
  runnersSpawned: number;
  watchHandlesAlive: number;
  pendingFollowups: number;
}

export interface DaemonStatusSnapshot {
  tasks: readonly TaskRecord[];
  counters: DaemonStatusCounters;
}

/** Role inferred from the task record. */
function roleFor(task: TaskRecord): string {
  // Tasks can carry a `role` field via the `[extra:string]:unknown`
  // index signature. We accept either "role" or fall back to a
  // sensible default so the column is always non-empty.
  const r = (task as { role?: unknown }).role;
  if (typeof r === "string" && r.length > 0) return r;
  return "worker";
}

/** Format the per-task line per spec: id<TAB>role<TAB>last_heartbeat<TAB>pid|-. */
function formatTaskLine(task: TaskRecord): string {
  const hb = task.last_heartbeat ?? "-";
  const pid =
    task.live_runner_pid === null || task.live_runner_pid === undefined
      ? "-"
      : String(task.live_runner_pid);
  return [task.id, roleFor(task), hb, pid].join("\t");
}

/**
 * Render the snapshot as a single multi-line TSV string (no trailing
 * newline). Per-task lines come first, sorted by id for determinism,
 * then a blank line, then `KEY\tVALUE` counter lines.
 */
export function formatStatusTSV(snapshot: DaemonStatusSnapshot): string {
  const tasks = [...snapshot.tasks].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const taskLines = tasks.map(formatTaskLine);
  const counterLines = [
    ["events_handled", snapshot.counters.eventsHandled],
    ["runners_spawned", snapshot.counters.runnersSpawned],
    ["watch_handles_alive", snapshot.counters.watchHandlesAlive],
    ["pending_followups", snapshot.counters.pendingFollowups],
  ].map(([k, v]) => `${k}\t${v}`);
  // The blank line is the only separator between sections; the
  // counters block always has the same field order, so consumers
  // can rely on it.
  if (taskLines.length === 0) return counterLines.join("\n");
  return [...taskLines, "", ...counterLines].join("\n");
}
