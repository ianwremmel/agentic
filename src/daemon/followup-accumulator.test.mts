import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DispatchEvent, EventKind } from "../state/event.mts";
import type { TaskRecord } from "../state/task-record.mts";
import { TaskStore } from "../state/task-store.mts";

import { drain, ingest, pendingCount } from "./followup-accumulator.mts";

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "github:o/r#1",
    worktree: "/tmp/wt",
    head: null,
    session_id: null,
    subscriptions: [],
    last_heartbeat: null,
    live_runner_pid: null,
    pending_followup: null,
    ...overrides,
  };
}

function ev(kind: EventKind, ts: string): DispatchEvent {
  return { kind, task_id: "github:o/r#1", timestamp: ts, payload: {} };
}

describe("ingest", () => {
  it("returns enqueue when no runner is live", () => {
    const t = task();
    const d = ingest(t, ev("pr-comment", "2026-05-15T10:00:00.000Z"));
    assert.equal(d.action, "enqueue");
  });

  it("accumulates into pending_followup when a runner is live", () => {
    const t = task({ live_runner_pid: 1234 });
    const d = ingest(t, ev("pr-comment", "2026-05-15T10:00:00.000Z"));
    assert.equal(d.action, "accumulate");
    if (d.action === "accumulate") {
      assert.equal(pendingCount(d.task), 1);
    }
  });

  it("appends multiple events in order", () => {
    let t = task({ live_runner_pid: 1234 });
    const a = ev("pr-comment", "2026-05-15T10:00:00.000Z");
    const b = ev("ci-finished", "2026-05-15T10:00:01.000Z");
    const r1 = ingest(t, a);
    assert.equal(r1.action, "accumulate");
    if (r1.action === "accumulate") t = r1.task;
    const r2 = ingest(t, b);
    assert.equal(r2.action, "accumulate");
    if (r2.action === "accumulate") t = r2.task;
    assert.equal(pendingCount(t), 2);
  });

  it("rejects events for the wrong task_id", () => {
    const t = task({ live_runner_pid: 1234 });
    const wrong: DispatchEvent = {
      kind: "pr-comment",
      task_id: "github:other#9",
      timestamp: "2026-05-15T10:00:00.000Z",
      payload: {},
    };
    assert.throws(() => ingest(t, wrong), RangeError);
  });
});

describe("drain", () => {
  it("returns null events and clears pending when buffer is empty", () => {
    const t = task({ live_runner_pid: 1234 });
    const r = drain(t);
    assert.equal(r.events, null);
    assert.equal(r.task.pending_followup, null);
  });

  it("returns the single event unchanged when only one accumulated", () => {
    let t = task({ live_runner_pid: 1234 });
    const a = ev("pr-comment", "2026-05-15T10:00:00.000Z");
    const r1 = ingest(t, a);
    if (r1.action === "accumulate") t = r1.task;
    const r = drain(t);
    assert.ok(r.events);
    assert.equal(r.events!.length, 1);
    assert.deepEqual(r.events![0], a);
    assert.equal(r.task.pending_followup, null);
  });

  it("coalesces multiple PR events into pr-coalesced", () => {
    let t = task({ live_runner_pid: 1234 });
    const a = ev("pr-comment", "2026-05-15T10:00:00.000Z");
    const b = ev("pr-review", "2026-05-15T10:00:01.000Z");
    let r = ingest(t, a);
    if (r.action === "accumulate") t = r.task;
    r = ingest(t, b);
    if (r.action === "accumulate") t = r.task;
    const drained = drain(t);
    assert.ok(drained.events);
    assert.equal(drained.events!.length, 1);
    assert.equal(drained.events![0]!.kind, "pr-coalesced");
    const originals = (drained.events![0]!.payload as { originals: DispatchEvent[] }).originals;
    assert.equal(originals.length, 2);
  });

  it("clears the accumulator after drain", () => {
    let t = task({ live_runner_pid: 1234 });
    const r = ingest(t, ev("pr-comment", "2026-05-15T10:00:00.000Z"));
    if (r.action === "accumulate") t = r.task;
    const out = drain(t);
    assert.equal(out.task.pending_followup, null);
    assert.equal(pendingCount(out.task), 0);
  });
});

describe("persistence across daemon restart", () => {
  it("pending_followup survives a round-trip through TaskStore", async () => {
    const root = mkdtempSync(join(tmpdir(), "dispatch-fua-"));
    const store = new TaskStore({ root });
    let t = task({ live_runner_pid: 1234 });
    const r1 = ingest(t, ev("pr-comment", "2026-05-15T10:00:00.000Z"));
    if (r1.action === "accumulate") t = r1.task;
    const r2 = ingest(t, ev("pr-review", "2026-05-15T10:00:01.000Z"));
    if (r2.action === "accumulate") t = r2.task;
    await store.write(t);

    // Simulated daemon restart: re-read the record from disk.
    const reloaded = await store.read(t.id);
    assert.ok(reloaded, "task must round-trip");
    assert.equal(pendingCount(reloaded!), 2);

    // Drain after restart yields the coalesced batch.
    const drained = drain(reloaded!);
    assert.ok(drained.events);
    assert.equal(drained.events![0]!.kind, "pr-coalesced");
  });
});
