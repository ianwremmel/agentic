import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { TaskRecord } from "../state/task-record.mts";
import {
  AWAITING_CI_LONG_MS,
  DEFAULT_INTERVALS_MS,
  PollScheduler,
  inferStage,
  intervalForStage,
  type TimerFns,
  type TimerHandle,
} from "./poll-scheduler.mts";

function baseTask(id: string): TaskRecord {
  return {
    id,
    worktree: `/tmp/${id}`,
    head: null,
    session_id: null,
    subscriptions: [],
    last_heartbeat: null,
    live_runner_pid: null,
    pending_followup: null,
  };
}

describe("inferStage", () => {
  it("returns idle when no hints are set", () => {
    assert.equal(inferStage({}), "idle");
  });

  it("prefers awaiting-ci over awaiting-copilot-review", () => {
    assert.equal(
      inferStage({ awaiting_ci: true, awaiting_copilot_review: true }),
      "awaiting-ci",
    );
  });

  it("maps each individual hint to its stage", () => {
    assert.equal(
      inferStage({ awaiting_copilot_review: true }),
      "awaiting-copilot-review",
    );
    assert.equal(
      inferStage({ awaiting_human_review: true }),
      "awaiting-human-reviewer",
    );
    assert.equal(
      inferStage({ awaiting_ticket_transition: true }),
      "awaiting-ticket-transition",
    );
  });
});

describe("intervalForStage", () => {
  it("matches the cadence table for non-CI stages", () => {
    assert.equal(intervalForStage("awaiting-copilot-review"), 30_000);
    assert.equal(intervalForStage("awaiting-human-reviewer"), 5 * 60_000);
    assert.equal(intervalForStage("awaiting-ticket-transition"), 5 * 60_000);
    assert.equal(intervalForStage("idle"), 15 * 60_000);
  });

  it("uses 60s for the first awaiting-ci poll and 5 min afterwards", () => {
    assert.equal(intervalForStage("awaiting-ci", { ci_poll_count: 0 }), 60_000);
    assert.equal(
      intervalForStage("awaiting-ci", { ci_poll_count: 1 }),
      AWAITING_CI_LONG_MS,
    );
    assert.equal(
      intervalForStage("awaiting-ci", { ci_poll_count: 17 }),
      AWAITING_CI_LONG_MS,
    );
  });

  it("honors overrides from config", () => {
    assert.equal(
      intervalForStage(
        "awaiting-copilot-review",
        {},
        { overrides: { "awaiting-copilot-review": 7_000 } },
      ),
      7_000,
    );
  });

  it("tightens within the transition window (halves with a floor)", () => {
    const now = 1_700_000_000_000;
    const at = new Date(now + 30_000).toISOString();
    // awaiting-human-reviewer base = 5 min; halved = 150_000.
    assert.equal(
      intervalForStage(
        "awaiting-human-reviewer",
        { expected_transition_at: at },
        { now: () => now },
      ),
      150_000,
    );
  });

  it("applies the tighten floor", () => {
    const now = 1_700_000_000_000;
    const at = new Date(now + 1_000).toISOString();
    // awaiting-copilot-review base = 30s → halved 15s; floor 20s wins.
    assert.equal(
      intervalForStage(
        "awaiting-copilot-review",
        { expected_transition_at: at },
        { now: () => now, tightenFloorMs: 20_000 },
      ),
      20_000,
    );
  });

  it("does not tighten when the transition is far away", () => {
    const now = 1_700_000_000_000;
    const at = new Date(now + 10 * 60_000).toISOString();
    assert.equal(
      intervalForStage(
        "awaiting-human-reviewer",
        { expected_transition_at: at },
        { now: () => now },
      ),
      5 * 60_000,
    );
  });

  it("ignores invalid expected_transition_at", () => {
    assert.equal(
      intervalForStage(
        "awaiting-human-reviewer",
        { expected_transition_at: "not-a-date" },
      ),
      5 * 60_000,
    );
  });

  it("intervals are NOT constant across stages — data-driven assertion", () => {
    const values = new Set(Object.values(DEFAULT_INTERVALS_MS));
    // At least 3 distinct values across 5 stages — proves the table
    // isn't accidentally collapsed to a single constant.
    assert.ok(values.size >= 3, `expected ≥3 distinct intervals, got ${values.size}`);
  });
});

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
  fire(handle: TimerHandle): void {
    const entry = this.fns.get(handle as number);
    if (!entry) throw new Error("no such timer");
    this.fns.delete(handle as number);
    entry.cb();
  }
  /** The most recently armed timer. */
  latest(): { handle: TimerHandle; ms: number } {
    const entries = [...this.fns.entries()];
    const [id, { ms }] = entries[entries.length - 1]!;
    return { handle: id, ms };
  }
}

describe("PollScheduler", () => {
  it("arms a timer with the inferred stage interval", () => {
    const timers = new FakeTimers();
    const ticks: string[] = [];
    const sched = new PollScheduler({
      tick: (id) => {
        ticks.push(id);
      },
      timers,
    });
    const r = sched.setTask({
      ...baseTask("t1"),
      awaiting_copilot_review: true,
    } as TaskRecord);
    assert.equal(r.stage, "awaiting-copilot-review");
    assert.equal(r.intervalMs, 30_000);
    assert.equal(timers.latest().ms, 30_000);
    assert.equal(sched.size(), 1);
  });

  it("reseats the timer on stage change", () => {
    const timers = new FakeTimers();
    const sched = new PollScheduler({ tick: () => {}, timers });
    const t = {
      ...baseTask("t1"),
      awaiting_copilot_review: true,
    } as TaskRecord;
    sched.setTask(t);
    const first = timers.latest().handle;
    sched.setTask({ ...t, awaiting_copilot_review: false, awaiting_ci: true } as TaskRecord);
    // Old timer must be cleared.
    assert.equal(timers.fns.has(first as number), false);
    assert.equal(timers.latest().ms, 60_000); // awaiting-ci first poll
  });

  it("invokes the tick callback when the timer fires and drops the entry", () => {
    const timers = new FakeTimers();
    const ticks: string[] = [];
    const sched = new PollScheduler({
      tick: (id) => {
        ticks.push(id);
      },
      timers,
    });
    sched.setTask({ ...baseTask("t1"), awaiting_ci: true } as TaskRecord);
    const { handle } = timers.latest();
    timers.fire(handle);
    assert.deepEqual(ticks, ["t1"]);
    // After firing, the task is removed (re-arm is the caller's job).
    assert.equal(sched.describe("t1"), null);
  });

  it("unscheduleTask cancels the armed timer", () => {
    const timers = new FakeTimers();
    const sched = new PollScheduler({ tick: () => {}, timers });
    sched.setTask({ ...baseTask("t1"), awaiting_ci: true } as TaskRecord);
    const { handle } = timers.latest();
    sched.unscheduleTask("t1");
    assert.equal(timers.fns.has(handle as number), false);
    assert.equal(sched.size(), 0);
  });

  it("stop() clears every entry", () => {
    const timers = new FakeTimers();
    const sched = new PollScheduler({ tick: () => {}, timers });
    sched.setTask({ ...baseTask("a"), awaiting_ci: true } as TaskRecord);
    sched.setTask({ ...baseTask("b"), awaiting_human_review: true } as TaskRecord);
    assert.equal(sched.size(), 2);
    sched.stop();
    assert.equal(sched.size(), 0);
    assert.equal(timers.fns.size, 0);
  });

  it("subsequent CI polls use the long interval", () => {
    const timers = new FakeTimers();
    const sched = new PollScheduler({ tick: () => {}, timers });
    sched.setTask({
      ...baseTask("t1"),
      awaiting_ci: true,
      ci_poll_count: 0,
    } as TaskRecord);
    assert.equal(timers.latest().ms, 60_000);
    sched.setTask({
      ...baseTask("t1"),
      awaiting_ci: true,
      ci_poll_count: 1,
    } as TaskRecord);
    assert.equal(timers.latest().ms, AWAITING_CI_LONG_MS);
  });
});
