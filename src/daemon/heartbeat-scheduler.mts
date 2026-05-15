// Heartbeat scheduler per
// `docs/spec/03-cli/01-daemon/02-normative.md` §Heartbeats.
//
// The daemon MUST fire a `heartbeat` event for every monitored task
// on a configurable cadence (default 10 minutes). A heartbeat MUST
// be suppressed when any other event for the same task was handled
// within the heartbeat window.
//
// This module exposes a per-task scheduler:
//
//   - `markActivity(taskId, ts)` — caller notifies the scheduler
//     whenever a non-heartbeat event for a task has been handled.
//     The window for `taskId` resets to `ts + cadence`.
//   - `start(taskId)` / `stop(taskId)` — begin / end heartbeat
//     monitoring for a task.
//   - The scheduler injects a `now()` clock and `setTimeout` /
//     `clearTimeout` shims so tests can drive it without
//     wall-clock waits.
//
// When the per-task timer fires, the scheduler invokes a
// caller-supplied `emit(taskId)` callback. The caller is
// responsible for:
//
//   1. Building and spooling the `heartbeat` DispatchEvent.
//   2. Updating the task's `last_heartbeat` via `state.TaskStore`.
//   3. Emitting the §2.3 operational log line.
//
// We keep all I/O out of this module so it's a pure timing
// primitive — same shape as `poll-scheduler.mts`.

export const DEFAULT_HEARTBEAT_CADENCE_MS = 10 * 60 * 1000;

export type TimerHandle = unknown;

export interface TimerFns {
  setTimeout: (cb: () => void, ms: number) => TimerHandle;
  clearTimeout: (h: TimerHandle) => void;
}

export interface HeartbeatSchedulerOptions {
  /** Heartbeat cadence in ms. Default 10 minutes. */
  cadenceMs?: number;
  /** Wall-clock provider; tests inject a controllable clock. */
  now?: () => number;
  /** Timer shims; tests inject fake timers. */
  timers?: TimerFns;
  /** Invoked when a task's heartbeat window elapses. */
  emit: (taskId: string) => void | Promise<void>;
}

interface Entry {
  handle: TimerHandle;
  fireAt: number;
}

export class HeartbeatScheduler {
  readonly cadenceMs: number;
  private readonly now: () => number;
  private readonly timers: TimerFns;
  private readonly emit: (taskId: string) => void | Promise<void>;
  private readonly tasks: Map<string, Entry> = new Map();

  constructor(opts: HeartbeatSchedulerOptions) {
    this.cadenceMs = opts.cadenceMs ?? DEFAULT_HEARTBEAT_CADENCE_MS;
    if (this.cadenceMs <= 0) {
      throw new RangeError("HeartbeatScheduler: cadenceMs must be > 0");
    }
    this.now = opts.now ?? Date.now;
    this.timers = opts.timers ?? {
      setTimeout: (cb, ms) => setTimeout(cb, ms),
      clearTimeout: (h) => {
        clearTimeout(h as ReturnType<typeof setTimeout>);
      },
    };
    this.emit = opts.emit;
  }

  /**
   * Begin monitoring `taskId`. The next heartbeat will fire after
   * `cadenceMs`, unless `markActivity` is called before then to
   * reset the window.
   */
  start(taskId: string): void {
    this.arm(taskId, this.now() + this.cadenceMs);
  }

  /** Stop monitoring `taskId`. */
  stop(taskId: string): void {
    const entry = this.tasks.get(taskId);
    if (!entry) return;
    this.timers.clearTimeout(entry.handle);
    this.tasks.delete(taskId);
  }

  /** True if `taskId` is being monitored. */
  has(taskId: string): boolean {
    return this.tasks.has(taskId);
  }

  /**
   * Notify the scheduler that a non-heartbeat event for `taskId`
   * was handled at `ts` (defaults to `now()`). The heartbeat
   * window is reset; the next heartbeat fires at `ts + cadenceMs`.
   *
   * No-op if the task isn't being monitored.
   */
  markActivity(taskId: string, ts?: number): void {
    if (!this.tasks.has(taskId)) return;
    const at = ts ?? this.now();
    this.arm(taskId, at + this.cadenceMs);
  }

  /** Test-only accessor: when is the next heartbeat scheduled? */
  fireAt(taskId: string): number | null {
    const e = this.tasks.get(taskId);
    return e ? e.fireAt : null;
  }

  /** Test/shutdown helper. */
  stopAll(): void {
    for (const taskId of [...this.tasks.keys()]) this.stop(taskId);
  }

  private arm(taskId: string, fireAt: number): void {
    const existing = this.tasks.get(taskId);
    if (existing) this.timers.clearTimeout(existing.handle);
    const delay = Math.max(0, fireAt - this.now());
    const handle = this.timers.setTimeout(() => {
      // After the timer fires, this entry is consumed. Re-arm
      // unconditionally for the next window — the caller will
      // also be notifying us via markActivity for any concurrent
      // non-heartbeat events, which would reset the window again.
      this.tasks.delete(taskId);
      if (this.tasks.get(taskId) === undefined) {
        // Re-arm for the next window FIRST so we keep firing on
        // cadence regardless of how long emit() takes.
        this.arm(taskId, this.now() + this.cadenceMs);
      }
      // emit() may be async; we don't await — heartbeats are
      // fire-and-forget per §Heartbeats. Errors are the caller's
      // problem (the daemon will log + continue).
      void this.emit(taskId);
    }, delay);
    this.tasks.set(taskId, { handle, fireAt });
  }
}
