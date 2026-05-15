// Watch-subprocess manager per `docs/spec/03-cli/01-daemon/02-normative.md`
// §Event-source orchestration. Manages long-running watch processes
// (e.g. `gh pr checks --watch`, `bk build wait`) per (task, source)
// pair with capped exponential backoff on restart.
//
// Design contract:
//
// - A `Subscription` is keyed by `(taskId, source)`. Re-registering
//   the same key replaces the prior process (stopping it first).
// - The factory builds a fresh `ChildProcess` each time. The manager
//   owns lifecycle; the factory owns spawn semantics. Tests inject a
//   fake.
// - Backoff is 2s → 4s → 8s → 60s (cap). The clock starts at "the
//   moment the previous attempt's child exited". A successful
//   handshake (the first parsed event OR a configurable "stable"
//   duration; we use stable duration here) resets the backoff so a
//   long-lived watch that finally dies after hours doesn't wait 60s
//   to come back.
// - On unexpected exit (any non-zero, OR a zero exit before the
//   stable window), the manager:
//     1. Emits a `runner-error`-shaped event on the configured
//        eventSink describing the failure.
//     2. Schedules a restart at the current backoff slot.
// - On shutdown (`stop()` or `unsubscribe()`), the child receives
//   SIGTERM. If it has not exited within `gracePeriodMs` (default
//   5000ms), it receives SIGKILL.
// - The manager NEVER falls back to polling. Repeated failures stay
//   visible as recurring `runner-error` events; the caller (the
//   daemon) decides what to do (e.g., open an alert, set a stage hint
//   that opens a triage event).

import type { ChildProcess } from "node:child_process";

import type { DispatchEvent } from "../state/event.mts";
import type { TimerFns, TimerHandle } from "./poll-scheduler.mts";

export const BACKOFF_SCHEDULE_MS: ReadonlyArray<number> = [
  2_000,
  4_000,
  8_000,
  16_000,
  32_000,
  60_000,
];

/** Time a child must stay alive before its slot resets to step 0. */
export const STABLE_RESET_MS = 30_000;

/** Default grace period between SIGTERM and SIGKILL on shutdown. */
export const SHUTDOWN_GRACE_MS = 5_000;

export interface SubscriptionKey {
  taskId: string;
  source: string;
}

export interface SpawnedWatch {
  child: ChildProcess;
  /**
   * Iterable of structured events produced by the watcher (e.g.
   * parsed JSON lines). When the iterator throws or completes, the
   * watcher is considered failed. Optional: when omitted, the
   * manager only watches process exit.
   */
  events?: AsyncIterable<DispatchEvent>;
}

export type WatchFactory = (key: SubscriptionKey) => SpawnedWatch;

export interface WatchManagerOptions {
  factory: WatchFactory;
  /** Where parsed events are delivered. */
  onEvent: (key: SubscriptionKey, event: DispatchEvent) => void;
  /**
   * Synthetic events emitted by the manager itself: subprocess
   * crashes, restart attempts, SIGKILL escalations. The daemon
   * spools these into the event log.
   */
  onSystemEvent?: (key: SubscriptionKey, event: DispatchEvent) => void;
  /** PID changes for `subscriptions` field on TaskRecord. */
  onSubscriptionChange?: (key: SubscriptionKey, pid: number | null) => void;
  /** Backoff schedule override (tests). */
  backoffSchedule?: ReadonlyArray<number>;
  /** Stable duration override; defaults to STABLE_RESET_MS. */
  stableResetMs?: number;
  /** Grace period override; defaults to SHUTDOWN_GRACE_MS. */
  gracePeriodMs?: number;
  /** Timer injection. */
  timers?: TimerFns;
  /** Injectable now() for stability math. */
  now?: () => number;
}

interface Entry {
  key: SubscriptionKey;
  step: number;
  child: ChildProcess | null;
  startedAt: number;
  /** Timer scheduled for the next restart. */
  pending: TimerHandle | null;
  /** Set when we're tearing the entry down. */
  stopping: boolean;
}

function keyToString(key: SubscriptionKey): string {
  return `${key.taskId}\u0000${key.source}`;
}

export class WatchManager {
  private readonly entries = new Map<string, Entry>();
  private readonly factory: WatchFactory;
  private readonly onEvent: (k: SubscriptionKey, e: DispatchEvent) => void;
  private readonly onSystemEvent: (k: SubscriptionKey, e: DispatchEvent) => void;
  private readonly onSub: (k: SubscriptionKey, pid: number | null) => void;
  private readonly schedule: ReadonlyArray<number>;
  private readonly stableMs: number;
  private readonly graceMs: number;
  private readonly timers: TimerFns;
  private readonly now: () => number;

  constructor(opts: WatchManagerOptions) {
    this.factory = opts.factory;
    this.onEvent = opts.onEvent;
    this.onSystemEvent = opts.onSystemEvent ?? (() => {});
    this.onSub = opts.onSubscriptionChange ?? (() => {});
    this.schedule = opts.backoffSchedule ?? BACKOFF_SCHEDULE_MS;
    this.stableMs = opts.stableResetMs ?? STABLE_RESET_MS;
    this.graceMs = opts.gracePeriodMs ?? SHUTDOWN_GRACE_MS;
    this.timers = opts.timers ?? {
      setTimeout: (cb, ms) => globalThis.setTimeout(cb, ms),
      clearTimeout: (h) => globalThis.clearTimeout(h as NodeJS.Timeout),
    };
    this.now = opts.now ?? Date.now;
  }

  /**
   * Register or replace a watch for the given key. If a prior watch
   * exists, it is stopped first (SIGTERM + grace + SIGKILL).
   */
  async subscribe(key: SubscriptionKey): Promise<void> {
    const id = keyToString(key);
    const existing = this.entries.get(id);
    if (existing) await this.tearDown(existing);
    const entry: Entry = {
      key,
      step: 0,
      child: null,
      startedAt: 0,
      pending: null,
      stopping: false,
    };
    this.entries.set(id, entry);
    this.spawnNow(entry);
  }

  async unsubscribe(key: SubscriptionKey): Promise<void> {
    const id = keyToString(key);
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    await this.tearDown(entry);
  }

  /** Stop every watch. Each child receives SIGTERM + grace + SIGKILL. */
  async stop(): Promise<void> {
    const tearDowns: Array<Promise<void>> = [];
    for (const entry of this.entries.values()) {
      tearDowns.push(this.tearDown(entry));
    }
    this.entries.clear();
    await Promise.all(tearDowns);
  }

  /** Test-only inspection. */
  describe(key: SubscriptionKey): {
    step: number;
    pid: number | null;
    hasPending: boolean;
  } | null {
    const e = this.entries.get(keyToString(key));
    if (!e) return null;
    return {
      step: e.step,
      pid: e.child?.pid ?? null,
      hasPending: e.pending !== null,
    };
  }

  size(): number {
    return this.entries.size;
  }

  private spawnNow(entry: Entry): void {
    if (entry.stopping) return;
    if (entry.pending !== null) {
      this.timers.clearTimeout(entry.pending);
      entry.pending = null;
    }
    let spawned: SpawnedWatch;
    try {
      spawned = this.factory(entry.key);
    } catch (err) {
      this.emitFailure(entry, "spawn-threw", String(err));
      this.scheduleRestart(entry);
      return;
    }
    entry.child = spawned.child;
    entry.startedAt = this.now();
    this.onSub(entry.key, spawned.child.pid ?? null);

    if (spawned.events) {
      void this.pumpEvents(entry, spawned.events);
    }

    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      entry.child?.removeListener("exit", onExit);
      if (entry.stopping) {
        this.onSub(entry.key, null);
        return;
      }
      this.onSub(entry.key, null);
      const liveMs = this.now() - entry.startedAt;
      const reset = liveMs >= this.stableMs;
      if (reset) entry.step = 0;
      this.emitFailure(entry, "child-exit", `code=${code} signal=${signal} live_ms=${liveMs}`);
      this.scheduleRestart(entry);
    };
    spawned.child.on("exit", onExit);
  }

  private async pumpEvents(entry: Entry, events: AsyncIterable<DispatchEvent>): Promise<void> {
    try {
      for await (const ev of events) {
        if (entry.stopping) break;
        this.onEvent(entry.key, ev);
      }
    } catch (err) {
      if (entry.stopping) return;
      this.emitFailure(entry, "event-stream-error", String(err));
      // The exit handler will run the restart; we don't double-schedule.
    }
  }

  private emitFailure(entry: Entry, reason: string, detail: string): void {
    const ev: DispatchEvent = {
      kind: "runner-error",
      task_id: entry.key.taskId,
      timestamp: new Date(this.now()).toISOString(),
      payload: {
        scope: "watch-subprocess",
        source: entry.key.source,
        reason,
        detail,
        backoff_step: entry.step,
      },
    };
    this.onSystemEvent(entry.key, ev);
  }

  private scheduleRestart(entry: Entry): void {
    if (entry.stopping) return;
    const delay = this.schedule[Math.min(entry.step, this.schedule.length - 1)]!;
    entry.step = Math.min(entry.step + 1, this.schedule.length - 1);
    entry.pending = this.timers.setTimeout(() => {
      entry.pending = null;
      this.spawnNow(entry);
    }, delay);
  }

  private async tearDown(entry: Entry): Promise<void> {
    entry.stopping = true;
    if (entry.pending !== null) {
      this.timers.clearTimeout(entry.pending);
      entry.pending = null;
    }
    const child = entry.child;
    if (!child) return;
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      child.kill("SIGTERM");
    } catch {
      // Process may have already exited.
    }
    await this.waitForExitOrKill(child);
  }

  private waitForExitOrKill(child: ChildProcess): Promise<void> {
    return new Promise<void>((resolve) => {
      let resolved = false;
      const finish = () => {
        if (resolved) return;
        resolved = true;
        this.timers.clearTimeout(killTimer);
        resolve();
      };
      const killTimer = this.timers.setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // Already gone.
        }
        // Resolve regardless — we did our best.
        finish();
      }, this.graceMs);
      child.once("exit", finish);
    });
  }
}
