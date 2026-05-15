// Mutable follow-up accumulator per
// `docs/spec/03-cli/01-daemon/02-normative.md` §Mutable follow-up.
//
// When the daemon observes a change for a task whose `live_runner_pid`
// is set, it MUST NOT enqueue a separate event. Instead it accumulates
// the change into `pending_followup` on the task record. When the
// runner exits, if `pending_followup` is non-empty, the daemon
// immediately re-spawns the runner with the accumulated events and
// clears the accumulator.
//
// This module is a pure function over (TaskRecord, incoming event)
// pairs plus a small drain helper. Persistence is the caller's
// responsibility — the daemon writes the TaskRecord via
// `state.TaskStore` after each accumulate / drain. That keeps this
// module trivially testable and durable across daemon restarts
// because `pending_followup` lives on the task record on disk.
//
// Internal representation of `pending_followup`:
//
//   {
//     "events": DispatchEvent[]   // in observation order
//   }
//
// The accumulator preserves originals verbatim. Final coalescing
// happens at *drain* time so that we can keep the order of arrival
// for callers that want to inspect the buffer, while still applying
// the §Coalescing rule when the runner is finally re-spawned.

import type { DispatchEvent } from "../state/event.mts";
import type { TaskRecord } from "../state/task-record.mts";
import { coalesce } from "./coalesce.mts";

/** Shape stored in `TaskRecord.pending_followup`. */
export interface PendingFollowup {
  events: DispatchEvent[];
}

function emptyPending(): PendingFollowup {
  return { events: [] };
}

function readPending(task: TaskRecord): PendingFollowup {
  const raw = task.pending_followup;
  if (raw === null || raw === undefined) return emptyPending();
  const events = (raw as { events?: unknown }).events;
  if (!Array.isArray(events)) return emptyPending();
  // We trust the on-disk shape (this module is the only writer); a
  // malformed value reverts to empty rather than throwing because a
  // garbled follow-up should never block a runner from re-spawning.
  return { events: events as DispatchEvent[] };
}

/**
 * Decide what to do with an incoming event for a task:
 *
 *   - `accumulate` — the runner is live; merge into pending_followup
 *     and return the updated task record (caller persists).
 *   - `enqueue`    — the runner is idle; the event should be spooled
 *     normally and a runner spawn invoked.
 */
export type IncomingDisposition =
  | { action: "accumulate"; task: TaskRecord }
  | { action: "enqueue" };

export function ingest(task: TaskRecord, event: DispatchEvent): IncomingDisposition {
  if (event.task_id !== task.id) {
    throw new RangeError(
      `ingest: event.task_id (${event.task_id}) does not match task.id (${task.id})`,
    );
  }
  if (task.live_runner_pid === null || task.live_runner_pid === undefined) {
    return { action: "enqueue" };
  }
  const pending = readPending(task);
  pending.events.push(event);
  const updated: TaskRecord = {
    ...task,
    pending_followup: { events: pending.events },
  };
  return { action: "accumulate", task: updated };
}

/**
 * Called when a runner exits. If the task has accumulated events:
 *
 *   - returns the coalesced batch ready for the next spawn,
 *   - returns the task record with the accumulator cleared (caller
 *     persists before spawning).
 *
 * If the accumulator is empty, returns `null` events; the caller
 * should NOT spawn a follow-up runner in that case.
 *
 * Coalescing uses the §Coalescing rules — 2+ PR events become one
 * `pr-coalesced`, etc. — so the runner is re-invoked with at most a
 * single synthetic event per side plus any non-base passthroughs.
 */
export function drain(task: TaskRecord): { task: TaskRecord; events: DispatchEvent[] | null } {
  const pending = readPending(task);
  if (pending.events.length === 0) {
    return { task: { ...task, pending_followup: null }, events: null };
  }
  const coalesced = coalesce(pending.events);
  const cleared: TaskRecord = { ...task, pending_followup: null };
  return { task: cleared, events: coalesced };
}

/** Convenience accessor used by tests + observability. */
export function pendingCount(task: TaskRecord): number {
  return readPending(task).events.length;
}
