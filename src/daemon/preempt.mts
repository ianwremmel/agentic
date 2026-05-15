// Pre-emptive resume per `docs/spec/03-cli/01-daemon/02-normative.md`
// §Pre-emptive resume.
//
// When an incoming event is classified as session-invalidating, the
// daemon SIGTERMs the live runner, waits a configurable grace period
// for clean exit, then SIGKILLs if the process is still alive, and
// finally spawns a follow-up with the combined context (the
// triggering event PLUS any events already accumulated in
// `pending_followup` per #45).
//
// Default invalidating classes:
//   - PR closure
//   - PR base-branch change
//   - Force-push on the work branch
//
// Additional classes are injected via `extraClassifiers` (the future
// config loader, #23, supplies these).
//
// Payload conventions for the defaults (callers — the github watch
// producer — MUST set at least one of these markers on
// `pr-state-change` events; classifier looks at both `payload` and
// top-level fields to stay forgiving):
//
//   PR closed             payload.state === "closed"
//                       | payload.action === "closed"
//   Base branch changed   payload.base_changed === true
//                       | payload.action === "base_ref_changed"
//   Force-push on branch  payload.force_pushed === true
//                       | payload.action === "synchronize_force"
//
// This module is pure — it does not touch the filesystem or process
// table directly. Signals, process-existence checks, and sleeping
// are injected so unit tests are deterministic and so the daemon
// entrypoint can wire in `process.kill` / `setTimeout`.

import type { DispatchEvent } from "../state/event.mts";
import type { TaskRecord } from "../state/task-record.mts";
import type { PendingFollowup } from "./followup-accumulator.mts";

/** Why an event was classified as session-invalidating. */
export type InvalidatingReason =
  | "pr-closed"
  | "base-branch-changed"
  | "work-branch-force-pushed"
  | string; // for extra classifiers

/** Default grace period between SIGTERM and SIGKILL (5 s). */
export const DEFAULT_GRACE_MS = 5_000;

/** Poll interval while waiting for the runner to exit after SIGTERM. */
export const DEFAULT_POLL_MS = 100;

/**
 * Classifier function: returns a reason if the event is
 * session-invalidating, or `null` otherwise.
 */
export type Classifier = (event: DispatchEvent) => InvalidatingReason | null;

function readPayload(event: DispatchEvent): Record<string, unknown> {
  const p = event.payload;
  return p && typeof p === "object" ? (p as Record<string, unknown>) : {};
}

/** Built-in classifier covering the three default invalidating classes. */
export const defaultClassifier: Classifier = (event) => {
  if (event.kind !== "pr-state-change") return null;
  const p = readPayload(event);
  const action = p.action;
  const state = p.state;
  if (state === "closed" || action === "closed") return "pr-closed";
  if (p.base_changed === true || action === "base_ref_changed") {
    return "base-branch-changed";
  }
  if (p.force_pushed === true || action === "synchronize_force") {
    return "work-branch-force-pushed";
  }
  return null;
};

/**
 * Classify an event against the default classifier plus any extras.
 * The first classifier to produce a non-null reason wins (defaults
 * first, then extras in array order).
 */
export function classify(
  event: DispatchEvent,
  extraClassifiers: readonly Classifier[] = [],
): InvalidatingReason | null {
  const built = defaultClassifier(event);
  if (built !== null) return built;
  for (const c of extraClassifiers) {
    const r = c(event);
    if (r !== null) return r;
  }
  return null;
};

/**
 * Combined payload passed to the spawned follow-up runner. The
 * triggering event is kept distinct from the previously accumulated
 * tail so the runner can render them differently if it wants.
 */
export interface CombinedFollowupPayload {
  triggering_event: DispatchEvent;
  accumulated_events: DispatchEvent[];
}

function readPending(task: TaskRecord): PendingFollowup {
  const raw = (task as Record<string, unknown>).pending_followup;
  if (
    raw &&
    typeof raw === "object" &&
    Array.isArray((raw as PendingFollowup).events)
  ) {
    return raw as PendingFollowup;
  }
  return { events: [] };
}

/**
 * Build the combined context for a pre-emptive (or no-runner)
 * follow-up. The accumulator tail is whatever was sitting in
 * `pending_followup` at preempt time.
 */
export function buildCombinedPayload(
  task: TaskRecord,
  event: DispatchEvent,
): CombinedFollowupPayload {
  const pending = readPending(task);
  return {
    triggering_event: event,
    accumulated_events: pending.events.slice(),
  };
};

/** Injected process / timer surface so we can unit test deterministically. */
export interface PreemptDeps {
  /** Send `signal` to `pid`. Throw on permission/transport error. */
  sendSignal(pid: number, signal: "SIGTERM" | "SIGKILL"): void;
  /** True iff a process with `pid` is currently alive. */
  processExists(pid: number): boolean;
  /** Sleep helper; resolves after `ms` ms. */
  sleep(ms: number): Promise<void>;
}

export interface PreemptLiveRunnerOptions {
  pid: number;
  graceMs?: number;
  pollMs?: number;
}

/** Result of pre-empting a live runner. */
export interface PreemptedResult {
  /** True iff we had to send SIGKILL because grace expired. */
  hardKilled: boolean;
  /** Whether the runner is still alive after the procedure. */
  stillAlive: boolean;
}

/**
 * SIGTERM the runner, poll until it exits or `graceMs` elapses, then
 * SIGKILL if it is still alive. Returns whether we had to escalate.
 *
 * - If `processExists(pid)` is false up front, this is a no-op
 *   (`hardKilled: false, stillAlive: false`).
 * - The SIGKILL escalation is best-effort; we report `stillAlive`
 *   honestly so the caller can decide what to do (typically: log
 *   and proceed anyway; the OS will reap eventually).
 */
export async function preemptLiveRunner(
  deps: PreemptDeps,
  opts: PreemptLiveRunnerOptions,
): Promise<PreemptedResult> {
  const graceMs = opts.graceMs ?? DEFAULT_GRACE_MS;
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  if (!Number.isFinite(graceMs) || graceMs < 0) {
    throw new TypeError("graceMs must be a non-negative finite number");
  }
  if (!Number.isFinite(pollMs) || pollMs <= 0) {
    throw new TypeError("pollMs must be a positive finite number");
  }

  if (!deps.processExists(opts.pid)) {
    return { hardKilled: false, stillAlive: false };
  }

  deps.sendSignal(opts.pid, "SIGTERM");

  // Poll for clean exit up to graceMs.
  let elapsed = 0;
  while (elapsed < graceMs) {
    if (!deps.processExists(opts.pid)) {
      return { hardKilled: false, stillAlive: false };
    }
    const step = Math.min(pollMs, graceMs - elapsed);
    await deps.sleep(step);
    elapsed += step;
  }

  // Final check before escalating.
  if (!deps.processExists(opts.pid)) {
    return { hardKilled: false, stillAlive: false };
  }

  deps.sendSignal(opts.pid, "SIGKILL");
  // We don't busy-wait after SIGKILL — the OS will reap. Report
  // current liveness honestly.
  return { hardKilled: true, stillAlive: deps.processExists(opts.pid) };
}

/** Outcome of `handleInvalidatingEvent`. */
export type HandleResult =
  | { action: "pass-through" }
  | {
      action: "no-runner";
      reason: InvalidatingReason;
      combinedPayload: CombinedFollowupPayload;
    }
  | {
      action: "preempted";
      reason: InvalidatingReason;
      combinedPayload: CombinedFollowupPayload;
      hardKilled: boolean;
      stillAlive: boolean;
    };

export interface HandleInvalidatingEventOptions {
  task: TaskRecord;
  event: DispatchEvent;
  deps: PreemptDeps;
  extraClassifiers?: readonly Classifier[];
  graceMs?: number;
  pollMs?: number;
}

/**
 * Top-level orchestration:
 *   1. Classify; if not invalidating, return `pass-through`.
 *   2. If no live runner, return `no-runner` with combined payload
 *      (caller spawns a normal follow-up).
 *   3. Otherwise SIGTERM → grace → SIGKILL the live runner and
 *      return `preempted` with the combined payload (caller spawns
 *      the replacement runner).
 *
 * This function does NOT mutate the task record or spawn a runner.
 * The caller (daemon entrypoint) is responsible for clearing
 * `pending_followup` / `live_runner_pid` and starting the
 * replacement, exactly as it would after any other follow-up drain.
 */
export async function handleInvalidatingEvent(
  options: HandleInvalidatingEventOptions,
): Promise<HandleResult> {
  const reason = classify(options.event, options.extraClassifiers ?? []);
  if (reason === null) return { action: "pass-through" };

  const combinedPayload = buildCombinedPayload(options.task, options.event);
  const pidRaw = options.task.live_runner_pid;
  const pid =
    typeof pidRaw === "number" && Number.isInteger(pidRaw) && pidRaw > 0
      ? pidRaw
      : null;

  if (pid === null) {
    return { action: "no-runner", reason, combinedPayload };
  }

  const res = await preemptLiveRunner(options.deps, {
    pid,
    graceMs: options.graceMs,
    pollMs: options.pollMs,
  });

  return {
    action: "preempted",
    reason,
    combinedPayload,
    hardKilled: res.hardKilled,
    stillAlive: res.stillAlive,
  };
}
