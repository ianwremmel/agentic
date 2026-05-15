// Polling scheduler for the daemon — per `docs/spec/03-cli/01-daemon/02-normative.md`
// §Event-source orchestration.
//
// The daemon's polling loop is built from three concerns that are kept
// separate so they can be tested in isolation:
//
//   1. **Stage inference** (`inferStage`) — maps a task's current state
//      to one of the five stages from the cadence table.
//   2. **Interval lookup** (`intervalForStage`) — maps a stage (plus a
//      few hints) to a poll interval in milliseconds, applying the
//      special "60s once, then 5 min" rule for `awaiting-ci`, and the
//      transition-tightening heuristic.
//   3. **Scheduler** — a per-task timer registry that calls a tick
//      callback at the cadence chosen by 1+2. Timers are reseated each
//      time the task is upserted so a stage change takes effect on the
//      next tick boundary, not the current sleep.
//
// All three accept dependency injection (clock, timer functions, config
// overrides) so unit tests never actually have to wait wall-clock time.

import type { TaskRecord } from "../state/task-record.mts";

/** The five canonical polling stages from the cadence table. */
export type PollingStage =
  | "awaiting-copilot-review"
  | "awaiting-ci"
  | "awaiting-human-reviewer"
  | "awaiting-ticket-transition"
  | "idle";

export const DEFAULT_INTERVALS_MS: Readonly<Record<PollingStage, number>> = {
  "awaiting-copilot-review": 30_000,
  // First poll for an active head: 60s; afterwards: 5 minutes.
  "awaiting-ci": 60_000,
  "awaiting-human-reviewer": 5 * 60_000,
  "awaiting-ticket-transition": 5 * 60_000,
  idle: 15 * 60_000,
} as const;

/** Long interval used by `awaiting-ci` after the initial 60s probe. */
export const AWAITING_CI_LONG_MS = 5 * 60_000;

/**
 * Hints derived from the task record. We don't infer these from raw
 * fields here because the upstream stage-classification skill (#26)
 * owns that mapping; this module is concerned with cadence only.
 * `inferStage` accepts either a hint bag or a TaskRecord with these
 * hints attached as well-known properties.
 */
export interface StageHints {
  awaiting_copilot_review?: boolean;
  awaiting_ci?: boolean;
  awaiting_human_review?: boolean;
  awaiting_ticket_transition?: boolean;
  /**
   * Number of polls already performed against the *current* active CI
   * head. The first poll uses the 60s short interval; subsequent polls
   * step out to AWAITING_CI_LONG_MS.
   */
  ci_poll_count?: number;
  /**
   * RFC-3339 timestamp of an expected state transition (e.g. CI ETA
   * from `gh pr checks` or a Linear cycle boundary). When the current
   * wall clock is within `transition_tighten_window_ms` of this time,
   * we halve the interval (with a floor of 5s). This is the §SHOULD
   * "tighten near transition points" heuristic.
   */
  expected_transition_at?: string;
}

/** Read hints attached to a task record (a no-op coercion). */
export function hintsFromTask(task: TaskRecord): StageHints {
  const t = task as TaskRecord & StageHints;
  return {
    awaiting_copilot_review: t.awaiting_copilot_review,
    awaiting_ci: t.awaiting_ci,
    awaiting_human_review: t.awaiting_human_review,
    awaiting_ticket_transition: t.awaiting_ticket_transition,
    ci_poll_count: t.ci_poll_count,
    expected_transition_at: t.expected_transition_at,
  };
}

/**
 * Infer the polling stage. Hints are checked in priority order:
 *   awaiting-ci > awaiting-copilot-review > awaiting-human-reviewer
 *     > awaiting-ticket-transition > idle.
 *
 * CI is highest priority because an active build is the most
 * latency-sensitive signal: a green build typically unblocks merge or
 * next-step actions immediately, so we want the tightest cadence.
 */
export function inferStage(hints: StageHints): PollingStage {
  if (hints.awaiting_ci) return "awaiting-ci";
  if (hints.awaiting_copilot_review) return "awaiting-copilot-review";
  if (hints.awaiting_human_review) return "awaiting-human-reviewer";
  if (hints.awaiting_ticket_transition) return "awaiting-ticket-transition";
  return "idle";
}

export interface IntervalOptions {
  /** Overrides for the default cadence table (from config #23). */
  overrides?: Partial<Record<PollingStage, number>>;
  /** Long interval for `awaiting-ci` after the first poll. */
  awaitingCiLongMs?: number;
  /** Window for transition tightening; defaults to 60s. */
  transitionTightenWindowMs?: number;
  /** Floor when halving for tightening; defaults to 5s. */
  tightenFloorMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

/** Compute the next poll interval for a stage given hints. */
export function intervalForStage(
  stage: PollingStage,
  hints: StageHints = {},
  opts: IntervalOptions = {},
): number {
  const overrides = opts.overrides ?? {};
  let base: number;
  if (stage === "awaiting-ci") {
    const longMs = opts.awaitingCiLongMs ?? AWAITING_CI_LONG_MS;
    const shortMs = overrides[stage] ?? DEFAULT_INTERVALS_MS[stage];
    base = (hints.ci_poll_count ?? 0) >= 1 ? longMs : shortMs;
  } else {
    base = overrides[stage] ?? DEFAULT_INTERVALS_MS[stage];
  }

  // Transition tightening (SHOULD): if a transition is expected
  // within the tightening window, halve the interval (with a floor).
  const expectedAt = hints.expected_transition_at;
  if (expectedAt !== undefined) {
    const target = Date.parse(expectedAt);
    if (Number.isFinite(target)) {
      const now = (opts.now ?? Date.now)();
      const window = opts.transitionTightenWindowMs ?? 60_000;
      const delta = target - now;
      // Tighten if the transition is upcoming AND within the window,
      // OR has already happened in the recent past (we want one more
      // quick poll to confirm).
      if (delta <= window && delta >= -window) {
        const floor = opts.tightenFloorMs ?? 5_000;
        return Math.max(floor, Math.floor(base / 2));
      }
    }
  }
  return base;
}

/* ---------------------------------------------------------------- *
 * Scheduler                                                         *
 * ---------------------------------------------------------------- */

export type TickFn = (taskId: string) => void | Promise<void>;

export type TimerHandle = unknown;

export interface TimerFns {
  setTimeout: (cb: () => void, ms: number) => TimerHandle;
  clearTimeout: (handle: TimerHandle) => void;
}

export interface SchedulerOptions {
  tick: TickFn;
  /** Cadence overrides — forwarded to `intervalForStage`. */
  intervals?: IntervalOptions;
  /** Injectable timers; defaults to host timers. */
  timers?: TimerFns;
}

interface ScheduledEntry {
  task: TaskRecord;
  stage: PollingStage;
  intervalMs: number;
  handle: TimerHandle;
}

/**
 * Per-task polling scheduler.
 *
 * Lifecycle:
 *   - `setTask(record)` — (re)compute stage/interval and arm a one-shot
 *     timer. When the timer fires, `tick(taskId)` is invoked; the
 *     timer is NOT re-armed automatically. Callers re-arm by calling
 *     `setTask` again from inside `tick` after they refresh the
 *     record.  This makes intervals strictly data-driven on the
 *     latest task state and prevents stale long-sleeps from outliving
 *     a stage change.
 *   - `unscheduleTask(id)` — clear and forget.
 *   - `stop()` — clear every armed timer; the scheduler can be reused.
 */
export class PollScheduler {
  private readonly entries = new Map<string, ScheduledEntry>();
  private readonly tick: TickFn;
  private readonly intervals: IntervalOptions;
  private readonly timers: TimerFns;

  constructor(opts: SchedulerOptions) {
    this.tick = opts.tick;
    this.intervals = opts.intervals ?? {};
    this.timers = opts.timers ?? {
      setTimeout: (cb, ms) => globalThis.setTimeout(cb, ms),
      clearTimeout: (h) => globalThis.clearTimeout(h as NodeJS.Timeout),
    };
  }

  setTask(task: TaskRecord): { stage: PollingStage; intervalMs: number } {
    const existing = this.entries.get(task.id);
    if (existing) this.timers.clearTimeout(existing.handle);

    const hints = hintsFromTask(task);
    const stage = inferStage(hints);
    const intervalMs = intervalForStage(stage, hints, this.intervals);
    const handle = this.timers.setTimeout(() => {
      // Drop the entry before invoking the tick so a tick handler that
      // re-arms via setTask cannot collide with stale state.
      this.entries.delete(task.id);
      void this.tick(task.id);
    }, intervalMs);
    this.entries.set(task.id, { task, stage, intervalMs, handle });
    return { stage, intervalMs };
  }

  unscheduleTask(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.timers.clearTimeout(entry.handle);
    this.entries.delete(id);
  }

  stop(): void {
    for (const entry of this.entries.values()) {
      this.timers.clearTimeout(entry.handle);
    }
    this.entries.clear();
  }

  /** Test-only inspection. */
  describe(id: string): { stage: PollingStage; intervalMs: number } | null {
    const e = this.entries.get(id);
    return e ? { stage: e.stage, intervalMs: e.intervalMs } : null;
  }

  size(): number {
    return this.entries.size;
  }
}
