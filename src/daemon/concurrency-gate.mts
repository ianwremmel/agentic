// Concurrency caps per
// `docs/spec/03-cli/01-daemon/02-normative.md` §Concurrency limits.
//
// 1. **At most one live runner per task.** Concurrent invocations of
//    the same session ID are forbidden.
// 2. **A configurable cap on total live runners per machine**
//    (default 4). When the cap is reached, incoming event handlers
//    MUST wait and be admitted FIFO as runners exit.
//
// The §Concurrency limits cap is in-process: it's the daemon's own
// per-machine cap on simultaneously-running runner subprocesses.
// Cross-restart durability is provided by `live_runner_pid` on the
// TaskRecord (cleared during crash recovery, #47) — so on every
// fresh daemon start the in-process count begins at zero and
// admissions resume against current state.
//
// API:
//
//   const gate = new ConcurrencyGate({ maxLiveRunners: 4 });
//   const slot = await gate.acquire(taskId);
//   try { ... run runner ... } finally { slot.release(); }
//
// `acquire(taskId)` may resolve immediately (slot available + no
// existing live runner for this task) or queue the caller behind
// the FIFO admission list. If a runner for the same task is
// already live, `acquire` rejects with `TaskBusyError` — the
// caller must use the mutable-follow-up accumulator (#45) to
// fold the event into the in-flight task instead.

const DEFAULT_MAX_LIVE_RUNNERS = 4;

export class TaskBusyError extends Error {
  readonly taskId: string;
  constructor(taskId: string) {
    super(`task ${taskId} already has a live runner`);
    this.name = "TaskBusyError";
    this.taskId = taskId;
  }
}

export interface ConcurrencyGateOptions {
  /** Maximum simultaneously-running runner subprocesses. Default 4. */
  maxLiveRunners?: number;
}

export interface Slot {
  /** Releases this slot and admits the next FIFO waiter (if any). */
  release(): void;
}

interface Waiter {
  taskId: string;
  resolve: (slot: Slot) => void;
  reject: (err: Error) => void;
}

export class ConcurrencyGate {
  readonly maxLiveRunners: number;
  /** Task IDs currently holding a slot. */
  private readonly live: Set<string> = new Set();
  /** FIFO of pending acquisitions. */
  private readonly waiters: Waiter[] = [];

  constructor(opts: ConcurrencyGateOptions = {}) {
    this.maxLiveRunners = opts.maxLiveRunners ?? DEFAULT_MAX_LIVE_RUNNERS;
    if (this.maxLiveRunners < 1 || !Number.isInteger(this.maxLiveRunners)) {
      throw new RangeError(
        `ConcurrencyGate: maxLiveRunners must be an integer ≥ 1, got ${String(
          this.maxLiveRunners,
        )}`,
      );
    }
  }

  /**
   * Acquire a slot for `taskId`. Resolves with the slot when
   * admission is granted. Rejects with `TaskBusyError` if
   * `taskId` already has a live runner (regardless of cap).
   *
   * Admission ordering:
   *   - If `live` already contains `taskId`, reject immediately.
   *   - Else if `live.size < maxLiveRunners`, admit immediately.
   *   - Else, append to FIFO waiters; resolve when a slot opens.
   *
   * Note: callers must take care to interpret `TaskBusyError`
   * via the mutable-follow-up accumulator (#45) rather than
   * spawning a duplicate runner.
   */
  async acquire(taskId: string): Promise<Slot> {
    if (this.live.has(taskId)) {
      throw new TaskBusyError(taskId);
    }
    if (this.live.size < this.maxLiveRunners) {
      return this.admit(taskId);
    }
    return new Promise<Slot>((resolve, reject) => {
      this.waiters.push({ taskId, resolve, reject });
    });
  }

  /**
   * Snapshot of currently-live task IDs (debugging / introspection).
   * Returns a copy; safe to iterate.
   */
  liveSnapshot(): string[] {
    return [...this.live];
  }

  /** Number of callers currently queued for admission. */
  waiterCount(): number {
    return this.waiters.length;
  }

  /** Number of slots currently filled. */
  liveCount(): number {
    return this.live.size;
  }

  /**
   * Rejects every queued waiter — used by daemon shutdown. The
   * slots already held are NOT released (the runner subprocesses
   * are still alive); the daemon tears them down separately.
   */
  drainWaiters(reason: Error): void {
    while (this.waiters.length > 0) {
      const w = this.waiters.shift()!;
      w.reject(reason);
    }
  }

  private admit(taskId: string): Slot {
    this.live.add(taskId);
    let released = false;
    return {
      release: (): void => {
        if (released) return;
        released = true;
        this.live.delete(taskId);
        this.pump();
      },
    };
  }

  /**
   * After a slot is released, admit the head of the FIFO if there
   * is room and the head's taskId isn't already live (it shouldn't
   * be, since acquire() rejects re-entry — but we re-check defensively).
   */
  private pump(): void {
    while (this.live.size < this.maxLiveRunners && this.waiters.length > 0) {
      const w = this.waiters.shift()!;
      if (this.live.has(w.taskId)) {
        // Should never happen — but if a duplicate did somehow
        // queue, fail it rather than admit a second runner.
        w.reject(new TaskBusyError(w.taskId));
        continue;
      }
      w.resolve(this.admit(w.taskId));
    }
  }
}

export { DEFAULT_MAX_LIVE_RUNNERS };
