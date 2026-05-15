import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { HeartbeatScheduler, DEFAULT_HEARTBEAT_CADENCE_MS } from "./heartbeat-scheduler.mts";

// Minimal fake timer system: a priority queue of (fireAt, cb).
class FakeTimers {
  private nowMs = 1_700_000_000_000;
  private next = 1;
  private q: Map<number, { fireAt: number; cb: () => void }> = new Map();

  now = (): number => this.nowMs;

  setTimeout = (cb: () => void, ms: number): unknown => {
    const id = this.next++;
    this.q.set(id, { fireAt: this.nowMs + ms, cb });
    return id;
  };

  clearTimeout = (h: unknown): void => {
    this.q.delete(h as number);
  };

  /** Advance time to `targetMs` past current `now`, firing any
   *  timers as we go in fireAt order. */
  advance(targetMs: number): void {
    const end = this.nowMs + targetMs;
    while (true) {
      let nextId: number | null = null;
      let nextFireAt = Infinity;
      for (const [id, t] of this.q) {
        if (t.fireAt <= end && t.fireAt < nextFireAt) {
          nextId = id;
          nextFireAt = t.fireAt;
        }
      }
      if (nextId === null) break;
      const t = this.q.get(nextId)!;
      this.q.delete(nextId);
      this.nowMs = t.fireAt;
      t.cb();
    }
    this.nowMs = end;
  }
}

describe("HeartbeatScheduler — cadence", () => {
  it("fires once per cadence window", () => {
    const fires: string[] = [];
    const timers = new FakeTimers();
    const s = new HeartbeatScheduler({
      cadenceMs: 1000,
      now: timers.now,
      timers,
      emit: (id) => {
        fires.push(id);
      },
    });
    s.start("t1");
    timers.advance(999);
    assert.equal(fires.length, 0);
    timers.advance(2);
    assert.deepEqual(fires, ["t1"]);
    // Re-arms automatically.
    timers.advance(1000);
    assert.deepEqual(fires, ["t1", "t1"]);
  });

  it("uses 10-minute default cadence", () => {
    const s = new HeartbeatScheduler({ emit: () => {} });
    assert.equal(s.cadenceMs, DEFAULT_HEARTBEAT_CADENCE_MS);
    assert.equal(s.cadenceMs, 600_000);
  });

  it("rejects non-positive cadence", () => {
    assert.throws(() => new HeartbeatScheduler({ cadenceMs: 0, emit: () => {} }), RangeError);
    assert.throws(() => new HeartbeatScheduler({ cadenceMs: -1, emit: () => {} }), RangeError);
  });
});

describe("HeartbeatScheduler — suppression by activity", () => {
  it("markActivity within the window pushes the heartbeat out", () => {
    const fires: string[] = [];
    const timers = new FakeTimers();
    const s = new HeartbeatScheduler({
      cadenceMs: 1000,
      now: timers.now,
      timers,
      emit: (id) => {
        fires.push(id);
      },
    });
    s.start("t1");
    timers.advance(500); // halfway through window
    s.markActivity("t1"); // resets — next fire at now+1000
    timers.advance(600); // 1100ms since start, but only 600ms since activity
    assert.equal(fires.length, 0, "no heartbeat: activity reset the window");
    timers.advance(500); // 1100ms since activity
    assert.deepEqual(fires, ["t1"]);
  });

  it("markActivity is a no-op for untracked tasks", () => {
    const fires: string[] = [];
    const timers = new FakeTimers();
    const s = new HeartbeatScheduler({
      cadenceMs: 1000,
      now: timers.now,
      timers,
      emit: (id) => {
        fires.push(id);
      },
    });
    s.markActivity("t1"); // no-op — t1 not started
    timers.advance(10_000);
    assert.equal(fires.length, 0);
  });

  it("repeated activity continuously suppresses the heartbeat", () => {
    const fires: string[] = [];
    const timers = new FakeTimers();
    const s = new HeartbeatScheduler({
      cadenceMs: 1000,
      now: timers.now,
      timers,
      emit: (id) => {
        fires.push(id);
      },
    });
    s.start("t1");
    for (let i = 0; i < 10; i++) {
      timers.advance(900);
      s.markActivity("t1");
    }
    assert.equal(fires.length, 0, "10 reset cycles: heartbeat never fired");
    timers.advance(1100);
    assert.deepEqual(fires, ["t1"]);
  });
});

describe("HeartbeatScheduler — lifecycle", () => {
  it("stop cancels the pending heartbeat", () => {
    const fires: string[] = [];
    const timers = new FakeTimers();
    const s = new HeartbeatScheduler({
      cadenceMs: 1000,
      now: timers.now,
      timers,
      emit: (id) => {
        fires.push(id);
      },
    });
    s.start("t1");
    s.stop("t1");
    timers.advance(5000);
    assert.equal(fires.length, 0);
    assert.equal(s.has("t1"), false);
  });

  it("tracks multiple tasks independently", () => {
    const fires: string[] = [];
    const timers = new FakeTimers();
    const s = new HeartbeatScheduler({
      cadenceMs: 1000,
      now: timers.now,
      timers,
      emit: (id) => {
        fires.push(id);
      },
    });
    s.start("a");
    timers.advance(400);
    s.start("b");
    timers.advance(700); // a: 1100ms (fired), b: 700ms
    assert.deepEqual(fires, ["a"]);
    timers.advance(400); // b: 1100ms
    assert.deepEqual(fires.slice().sort(), ["a", "b"]);
  });

  it("stopAll cancels every pending heartbeat", () => {
    const fires: string[] = [];
    const timers = new FakeTimers();
    const s = new HeartbeatScheduler({
      cadenceMs: 1000,
      now: timers.now,
      timers,
      emit: (id) => {
        fires.push(id);
      },
    });
    s.start("a");
    s.start("b");
    s.start("c");
    s.stopAll();
    timers.advance(5000);
    assert.equal(fires.length, 0);
  });

  it("fireAt reports the scheduled wall-clock time", () => {
    const timers = new FakeTimers();
    const s = new HeartbeatScheduler({
      cadenceMs: 1000,
      now: timers.now,
      timers,
      emit: () => {},
    });
    s.start("t1");
    assert.equal(s.fireAt("t1"), timers.now() + 1000);
    s.stop("t1");
    assert.equal(s.fireAt("t1"), null);
  });
});
