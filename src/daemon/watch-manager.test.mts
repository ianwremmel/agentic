import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import type { ChildProcess } from "node:child_process";
import type { DispatchEvent } from "../state/event.mts";

import {
  BACKOFF_SCHEDULE_MS,
  WatchManager,
  type SubscriptionKey,
} from "./watch-manager.mts";
import type { TimerFns, TimerHandle } from "./poll-scheduler.mts";

class FakeChild extends EventEmitter {
  pid: number;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed: NodeJS.Signals[] = [];

  constructor(pid: number) {
    super();
    this.pid = pid;
  }
  kill(sig: NodeJS.Signals = "SIGTERM"): boolean {
    this.killed.push(sig);
    return true;
  }
  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
  }
}

class FakeTimers implements TimerFns {
  next = 1;
  fns = new Map<number, { cb: () => void; ms: number }>();
  setTimeout(cb: () => void, ms: number): TimerHandle {
    const id = this.next++;
    this.fns.set(id, { cb, ms });
    return id;
  }
  clearTimeout(h: TimerHandle): void {
    this.fns.delete(h as number);
  }
  fireLatest(): number {
    const entries = [...this.fns.entries()];
    const [id, { cb, ms }] = entries[entries.length - 1]!;
    this.fns.delete(id);
    cb();
    return ms;
  }
  durations(): number[] {
    return [...this.fns.values()].map((v) => v.ms);
  }
}

const key: SubscriptionKey = { taskId: "github:o/r#1", source: "buildkite" };

function makeManager() {
  const timers = new FakeTimers();
  const children: FakeChild[] = [];
  let now = 1_000_000;
  const systemEvents: DispatchEvent[] = [];
  const subChanges: Array<{ pid: number | null }> = [];

  const mgr = new WatchManager({
    factory: () => {
      const c = new FakeChild(1000 + children.length);
      children.push(c);
      return { child: c as unknown as ChildProcess };
    },
    onEvent: () => {},
    onSystemEvent: (_k, e) => systemEvents.push(e),
    onSubscriptionChange: (_k, pid) => subChanges.push({ pid }),
    timers,
    now: () => now,
    gracePeriodMs: 1000,
  });
  return {
    mgr,
    timers,
    children,
    systemEvents,
    subChanges,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("WatchManager", () => {
  it("spawns on subscribe and notifies the subscription PID", async () => {
    const { mgr, children, subChanges } = makeManager();
    await mgr.subscribe(key);
    assert.equal(children.length, 1);
    assert.equal(subChanges[0]?.pid, children[0]!.pid);
    assert.equal(mgr.describe(key)?.pid, children[0]!.pid);
  });

  it("restarts on unexpected exit with capped exponential backoff (2,4,8,…,60s)", async () => {
    const { mgr, timers, children, advance } = makeManager();
    await mgr.subscribe(key);
    // First crash immediately (live_ms=0 < STABLE_RESET_MS) → step 0 backoff = 2s.
    children[0]!.exit(1);
    assert.equal(timers.durations()[0], BACKOFF_SCHEDULE_MS[0]);
    timers.fireLatest(); // restart -> spawn child #2

    // Second crash immediately → step 1 backoff = 4s.
    children[1]!.exit(1);
    assert.equal(timers.durations()[0], BACKOFF_SCHEDULE_MS[1]);
    timers.fireLatest();

    // Third crash → step 2 backoff = 8s.
    children[2]!.exit(1);
    assert.equal(timers.durations()[0], BACKOFF_SCHEDULE_MS[2]);

    // Keep crashing — verify the cap holds.
    for (let i = 3; i < 12; i++) {
      timers.fireLatest();
      children[i]!.exit(1);
    }
    const lastDelay = timers.durations()[0]!;
    assert.equal(lastDelay, 60_000);
    advance(0);
  });

  it("resets backoff after a stable run", async () => {
    const { mgr, timers, children, advance } = makeManager();
    await mgr.subscribe(key);
    children[0]!.exit(1); // step 0
    timers.fireLatest();
    advance(60_000); // child stays alive >= STABLE_RESET_MS (30s)
    children[1]!.exit(1);
    // After stable run, backoff resets to step 0 again (2s).
    assert.equal(timers.durations()[0], BACKOFF_SCHEDULE_MS[0]);
  });

  it("emits a runner-error system event on every crash and never silently falls back", async () => {
    const { mgr, children, systemEvents } = makeManager();
    await mgr.subscribe(key);
    children[0]!.exit(2);
    assert.equal(systemEvents.length, 1);
    assert.equal(systemEvents[0]!.kind, "runner-error");
    assert.equal(systemEvents[0]!.task_id, key.taskId);
    const payload = systemEvents[0]!.payload as Record<string, unknown>;
    assert.equal(payload.scope, "watch-subprocess");
    assert.equal(payload.source, "buildkite");
  });

  it("unsubscribe sends SIGTERM and SIGKILLs after the grace period", async () => {
    const { mgr, timers, children } = makeManager();
    await mgr.subscribe(key);
    const child = children[0]!;
    const unsub = mgr.unsubscribe(key);
    assert.deepEqual(child.killed, ["SIGTERM"]);
    // grace timer pending; fire it to escalate to SIGKILL.
    timers.fireLatest();
    await unsub;
    assert.deepEqual(child.killed, ["SIGTERM", "SIGKILL"]);
  });

  it("unsubscribe resolves immediately when the child exits within the grace window", async () => {
    const { mgr, children } = makeManager();
    await mgr.subscribe(key);
    const child = children[0]!;
    const unsub = mgr.unsubscribe(key);
    child.exit(0);
    await unsub;
    assert.deepEqual(child.killed, ["SIGTERM"]);
    assert.equal(mgr.size(), 0);
  });

  it("stop() tears down every entry", async () => {
    const { mgr, children } = makeManager();
    await mgr.subscribe({ taskId: "t1", source: "ci" });
    await mgr.subscribe({ taskId: "t2", source: "linear" });
    const stop = mgr.stop();
    for (const c of children) c.exit(0);
    await stop;
    assert.equal(mgr.size(), 0);
  });

  it("re-subscribing replaces the prior watch", async () => {
    const { mgr, children, timers } = makeManager();
    await mgr.subscribe(key);
    const first = children[0]!;
    const second = mgr.subscribe(key);
    first.exit(0);
    await second;
    // Second factory call → second child.
    assert.equal(children.length, 2);
    assert.equal(mgr.describe(key)?.pid, children[1]!.pid);
    // Sanity: prior child got SIGTERM.
    assert.deepEqual(first.killed, ["SIGTERM"]);
    void timers;
  });

  it("scheduleRestart caps at the last slot (60s) — schedule length sanity", () => {
    // Belt-and-braces structural assertion the spec mandates.
    assert.equal(BACKOFF_SCHEDULE_MS[BACKOFF_SCHEDULE_MS.length - 1], 60_000);
    assert.deepEqual(
      [BACKOFF_SCHEDULE_MS[0], BACKOFF_SCHEDULE_MS[1], BACKOFF_SCHEDULE_MS[2]],
      [2_000, 4_000, 8_000],
    );
  });
});
