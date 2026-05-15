import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { DispatchEvent } from "../state/event.mts";
import type { TaskRecord } from "../state/task-record.mts";
import {
  DEFAULT_GRACE_MS,
  buildCombinedPayload,
  classify,
  defaultClassifier,
  handleInvalidatingEvent,
  preemptLiveRunner,
  type Classifier,
  type PreemptDeps,
} from "./preempt.mts";

function ev(kind: DispatchEvent["kind"], payload: Record<string, unknown> = {}): DispatchEvent {
  return {
    kind,
    task_id: "t1",
    timestamp: "2026-05-15T12:00:00.000Z",
    payload,
  };
}

function task(over: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "t1",
    worktree: "/wt",
    head: "abc",
    session_id: "s1",
    subscriptions: [],
    last_heartbeat: null,
    live_runner_pid: null,
    pending_followup: null,
    ...over,
  } as TaskRecord;
}

// ---------- classify ----------

describe("defaultClassifier — built-in invalidating classes", () => {
  it("classifies PR closure via payload.state", () => {
    assert.equal(defaultClassifier(ev("pr-state-change", { state: "closed" })), "pr-closed");
  });

  it("classifies PR closure via payload.action", () => {
    assert.equal(defaultClassifier(ev("pr-state-change", { action: "closed" })), "pr-closed");
  });

  it("classifies base-branch change via payload.base_changed", () => {
    assert.equal(
      defaultClassifier(ev("pr-state-change", { base_changed: true })),
      "base-branch-changed",
    );
  });

  it("classifies base-branch change via payload.action", () => {
    assert.equal(
      defaultClassifier(ev("pr-state-change", { action: "base_ref_changed" })),
      "base-branch-changed",
    );
  });

  it("classifies force-push via payload.force_pushed", () => {
    assert.equal(
      defaultClassifier(ev("pr-state-change", { force_pushed: true })),
      "work-branch-force-pushed",
    );
  });

  it("classifies force-push via payload.action", () => {
    assert.equal(
      defaultClassifier(ev("pr-state-change", { action: "synchronize_force" })),
      "work-branch-force-pushed",
    );
  });

  it("returns null for ordinary pr-state-change events", () => {
    assert.equal(defaultClassifier(ev("pr-state-change", { state: "open" })), null);
  });

  it("returns null for non pr-state-change kinds", () => {
    assert.equal(defaultClassifier(ev("pr-comment", { state: "closed" })), null);
    assert.equal(defaultClassifier(ev("ci-finished", { force_pushed: true })), null);
  });
});

describe("classify — extra classifiers", () => {
  it("falls back to extras when defaults return null", () => {
    const extra: Classifier = (e) =>
      e.kind === "ci-finished" && e.payload.outcome === "secrets-revoked"
        ? "ci-secret-rotated"
        : null;
    assert.equal(
      classify(ev("ci-finished", { outcome: "secrets-revoked" }), [extra]),
      "ci-secret-rotated",
    );
  });

  it("default classifier wins over extras", () => {
    const extra: Classifier = () => "should-not-win";
    assert.equal(
      classify(ev("pr-state-change", { state: "closed" }), [extra]),
      "pr-closed",
    );
  });

  it("returns null if neither default nor extras match", () => {
    const extra: Classifier = () => null;
    assert.equal(classify(ev("pr-comment"), [extra]), null);
  });
});

// ---------- buildCombinedPayload ----------

describe("buildCombinedPayload", () => {
  it("returns triggering event plus empty accumulator when none pending", () => {
    const e = ev("pr-state-change", { state: "closed" });
    const c = buildCombinedPayload(task(), e);
    assert.deepEqual(c, { triggering_event: e, accumulated_events: [] });
  });

  it("returns triggering event plus copy of pending_followup events", () => {
    const tail = [ev("pr-comment"), ev("ci-finished")];
    const e = ev("pr-state-change", { state: "closed" });
    const c = buildCombinedPayload(
      task({ pending_followup: { events: tail } as unknown as TaskRecord["pending_followup"] }),
      e,
    );
    assert.equal(c.triggering_event, e);
    assert.deepEqual(c.accumulated_events, tail);
    // copy, not aliased
    assert.notEqual(c.accumulated_events, tail);
  });

  it("tolerates malformed pending_followup", () => {
    const e = ev("pr-state-change", { state: "closed" });
    const c = buildCombinedPayload(
      task({ pending_followup: { broken: true } as unknown as TaskRecord["pending_followup"] }),
      e,
    );
    assert.deepEqual(c.accumulated_events, []);
  });
});

// ---------- preemptLiveRunner ----------

class FakeProc {
  alive = true;
  signals: Array<{ pid: number; sig: string; at: number }> = [];
  exitAfterMs: number | null = null;
  firstSignalAt: number | null = null;
  clock: { ms: number };

  constructor(clock: { ms: number }) {
    this.clock = clock;
  }

  sendSignal = (pid: number, sig: "SIGTERM" | "SIGKILL"): void => {
    if (this.firstSignalAt === null) this.firstSignalAt = this.clock.ms;
    this.signals.push({ pid, sig, at: this.clock.ms });
    if (sig === "SIGKILL") this.alive = false;
  };

  processExists = (_pid: number): boolean => {
    if (
      this.exitAfterMs !== null &&
      this.firstSignalAt !== null &&
      this.clock.ms - this.firstSignalAt >= this.exitAfterMs
    ) {
      this.alive = false;
    }
    return this.alive;
  };
}

function makeDeps(proc: FakeProc, clock: { ms: number }): PreemptDeps {
  return {
    sendSignal: proc.sendSignal,
    processExists: proc.processExists,
    sleep: (ms) => {
      clock.ms += ms;
      return Promise.resolve();
    },
  };
}

describe("preemptLiveRunner", () => {
  it("is a no-op when the runner has already exited", async () => {
    const clock = { ms: 0 };
    const proc = new FakeProc(clock);
    proc.alive = false;
    const res = await preemptLiveRunner(makeDeps(proc, clock), { pid: 123 });
    assert.deepEqual(res, { hardKilled: false, stillAlive: false });
    assert.equal(proc.signals.length, 0);
  });

  it("sends SIGTERM and returns clean when the runner exits within grace", async () => {
    const clock = { ms: 0 };
    const proc = new FakeProc(clock);
    proc.exitAfterMs = 200; // exits 200 ms after first signal
    const res = await preemptLiveRunner(makeDeps(proc, clock), {
      pid: 1,
      graceMs: 5_000,
      pollMs: 50,
    });
    assert.deepEqual(res, { hardKilled: false, stillAlive: false });
    assert.equal(proc.signals.length, 1);
    assert.equal(proc.signals[0].sig, "SIGTERM");
    // Should not have waited the full grace period.
    assert.ok(clock.ms < 5_000, `elapsed ${clock.ms} < 5000`);
    assert.ok(clock.ms >= 200, `elapsed ${clock.ms} >= 200`);
  });

  it("escalates to SIGKILL when grace expires", async () => {
    const clock = { ms: 0 };
    const proc = new FakeProc(clock); // never exits on its own
    const res = await preemptLiveRunner(makeDeps(proc, clock), {
      pid: 7,
      graceMs: 500,
      pollMs: 50,
    });
    assert.equal(res.hardKilled, true);
    assert.equal(res.stillAlive, false); // FakeProc.sendSignal SIGKILL flips alive=false
    assert.equal(proc.signals.length, 2);
    assert.equal(proc.signals[0].sig, "SIGTERM");
    assert.equal(proc.signals[1].sig, "SIGKILL");
    // SIGKILL fired only after grace window elapsed.
    assert.ok(
      proc.signals[1].at >= 500,
      `SIGKILL at ${proc.signals[1].at} after >= 500ms`,
    );
  });

  it("reports stillAlive when SIGKILL fails to reap immediately", async () => {
    const clock = { ms: 0 };
    const proc = new FakeProc(clock);
    // override: SIGKILL doesn't kill (e.g. zombie)
    proc.sendSignal = (pid, sig) => {
      proc.signals.push({ pid, sig, at: clock.ms });
    };
    const res = await preemptLiveRunner(makeDeps(proc, clock), {
      pid: 9,
      graceMs: 100,
      pollMs: 50,
    });
    assert.equal(res.hardKilled, true);
    assert.equal(res.stillAlive, true);
  });

  it("rejects invalid graceMs / pollMs", async () => {
    const clock = { ms: 0 };
    const proc = new FakeProc(clock);
    const deps = makeDeps(proc, clock);
    await assert.rejects(
      () => preemptLiveRunner(deps, { pid: 1, graceMs: -1 }),
      /graceMs/,
    );
    await assert.rejects(
      () => preemptLiveRunner(deps, { pid: 1, pollMs: 0 }),
      /pollMs/,
    );
  });

  it("respects DEFAULT_GRACE_MS when none provided", async () => {
    assert.equal(DEFAULT_GRACE_MS, 5_000);
  });
});

// ---------- handleInvalidatingEvent ----------

describe("handleInvalidatingEvent", () => {
  it("returns pass-through for non-invalidating events", async () => {
    const clock = { ms: 0 };
    const proc = new FakeProc(clock);
    const res = await handleInvalidatingEvent({
      task: task({ live_runner_pid: 42 }),
      event: ev("pr-comment"),
      deps: makeDeps(proc, clock),
    });
    assert.deepEqual(res, { action: "pass-through" });
    assert.equal(proc.signals.length, 0);
  });

  it("returns no-runner (no signals) when nothing is live", async () => {
    const clock = { ms: 0 };
    const proc = new FakeProc(clock);
    const e = ev("pr-state-change", { state: "closed" });
    const res = await handleInvalidatingEvent({
      task: task({ live_runner_pid: null }),
      event: e,
      deps: makeDeps(proc, clock),
    });
    assert.equal(res.action, "no-runner");
    if (res.action !== "no-runner") return;
    assert.equal(res.reason, "pr-closed");
    assert.equal(res.combinedPayload.triggering_event, e);
    assert.equal(proc.signals.length, 0);
  });

  it("preempts the live runner and returns combined payload", async () => {
    const clock = { ms: 0 };
    const proc = new FakeProc(clock);
    proc.exitAfterMs = 100;
    const tail = [ev("pr-comment", { n: 1 }), ev("pr-comment", { n: 2 })];
    const e = ev("pr-state-change", { action: "base_ref_changed" });
    const res = await handleInvalidatingEvent({
      task: task({
        live_runner_pid: 555,
        pending_followup: { events: tail } as unknown as TaskRecord["pending_followup"],
      }),
      event: e,
      deps: makeDeps(proc, clock),
      graceMs: 2_000,
      pollMs: 25,
    });
    assert.equal(res.action, "preempted");
    if (res.action !== "preempted") return;
    assert.equal(res.reason, "base-branch-changed");
    assert.equal(res.hardKilled, false);
    assert.equal(res.stillAlive, false);
    assert.equal(res.combinedPayload.triggering_event, e);
    assert.deepEqual(res.combinedPayload.accumulated_events, tail);
    assert.equal(proc.signals.length, 1);
    assert.equal(proc.signals[0].sig, "SIGTERM");
  });

  it("falls through to SIGKILL when the runner ignores SIGTERM", async () => {
    const clock = { ms: 0 };
    const proc = new FakeProc(clock); // never exits
    const e = ev("pr-state-change", { force_pushed: true });
    const res = await handleInvalidatingEvent({
      task: task({ live_runner_pid: 999 }),
      event: e,
      deps: makeDeps(proc, clock),
      graceMs: 300,
      pollMs: 50,
    });
    assert.equal(res.action, "preempted");
    if (res.action !== "preempted") return;
    assert.equal(res.reason, "work-branch-force-pushed");
    assert.equal(res.hardKilled, true);
    assert.deepEqual(
      proc.signals.map((s) => s.sig),
      ["SIGTERM", "SIGKILL"],
    );
  });

  it("treats non-integer live_runner_pid as no-runner", async () => {
    const clock = { ms: 0 };
    const proc = new FakeProc(clock);
    const e = ev("pr-state-change", { state: "closed" });
    const res = await handleInvalidatingEvent({
      task: task({ live_runner_pid: 0 }),
      event: e,
      deps: makeDeps(proc, clock),
    });
    assert.equal(res.action, "no-runner");
    assert.equal(proc.signals.length, 0);
  });

  it("uses extra classifiers from options", async () => {
    const clock = { ms: 0 };
    const proc = new FakeProc(clock);
    const extra: Classifier = (e) =>
      e.kind === "ticket-state" && e.payload.closed === true ? "ticket-closed" : null;
    const res = await handleInvalidatingEvent({
      task: task({ live_runner_pid: null }),
      event: ev("ticket-state", { closed: true }),
      deps: makeDeps(proc, clock),
      extraClassifiers: [extra],
    });
    assert.equal(res.action, "no-runner");
    if (res.action !== "no-runner") return;
    assert.equal(res.reason, "ticket-closed");
  });
});
