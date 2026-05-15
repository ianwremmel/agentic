import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ensureStateLayout } from "../state/paths.mts";
import { EventSpool } from "../state/event-spool.mts";
import { TaskStore } from "../state/task-store.mts";
import type { TaskRecord } from "../state/task-record.mts";
import type { DispatchEvent } from "../state/event.mts";

import { recoverFromCrash } from "./crash-recovery.mts";

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "dispatch-crash-"));
}

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

const FIXED_NOW = "2026-05-15T18:00:00.000Z";

describe("recoverFromCrash", () => {
  it("returns zero report on a clean (empty) state", async () => {
    const root = tmpRoot();
    await ensureStateLayout(root);
    const taskStore = new TaskStore({ root });
    const eventSpool = new EventSpool({ root });

    const report = await recoverFromCrash({
      taskStore,
      eventSpool,
      now: () => FIXED_NOW,
    });

    assert.equal(report.tasks, 0);
    assert.deepEqual(report.replayedEvents, []);
    assert.deepEqual(report.synthesizedRestarts, []);
    assert.deepEqual(report.taskIdsToReattach, []);
  });

  it("rehydrates tasks and replays events oldest-first", async () => {
    const root = tmpRoot();
    await ensureStateLayout(root);
    const taskStore = new TaskStore({ root });
    const eventSpool = new EventSpool({ root });

    await taskStore.write(task({ id: "github:o/r#1" }));
    await taskStore.write(task({ id: "github:o/r#2" }));

    const e1: DispatchEvent = {
      kind: "pr-comment",
      task_id: "github:o/r#1",
      timestamp: "2026-05-15T10:00:00.000Z",
      payload: {},
    };
    const e2: DispatchEvent = {
      kind: "ci-finished",
      task_id: "github:o/r#1",
      timestamp: "2026-05-15T11:00:00.000Z",
      payload: {},
    };
    await eventSpool.enqueue(e2);
    await eventSpool.enqueue(e1);

    const report = await recoverFromCrash({
      taskStore,
      eventSpool,
      now: () => FIXED_NOW,
    });

    assert.equal(report.tasks, 2);
    assert.equal(report.replayedEvents.length, 2);
    assert.equal(report.replayedEvents[0]!.timestamp, e1.timestamp);
    assert.equal(report.replayedEvents[1]!.timestamp, e2.timestamp);
  });

  it("synthesizes daemon-restart for every task with live_runner_pid", async () => {
    const root = tmpRoot();
    await ensureStateLayout(root);
    const taskStore = new TaskStore({ root });
    const eventSpool = new EventSpool({ root });

    await taskStore.write(
      task({ id: "github:o/r#1", live_runner_pid: 12345 }),
    );
    await taskStore.write(task({ id: "github:o/r#2" })); // no live runner

    const report = await recoverFromCrash({
      taskStore,
      eventSpool,
      now: () => FIXED_NOW,
    });

    assert.equal(report.synthesizedRestarts.length, 1);
    const ev = report.synthesizedRestarts[0]!;
    assert.equal(ev.kind, "daemon-restart");
    assert.equal(ev.task_id, "github:o/r#1");
    assert.equal(ev.timestamp, FIXED_NOW);
    assert.equal((ev.payload as { live_runner_pid?: number }).live_runner_pid, 12345);
    assert.equal((ev.payload as { last_known_stage?: unknown }).last_known_stage, null);
  });

  it("queues the synthesized daemon-restart on the spool", async () => {
    const root = tmpRoot();
    await ensureStateLayout(root);
    const taskStore = new TaskStore({ root });
    const eventSpool = new EventSpool({ root });

    await taskStore.write(
      task({ id: "github:o/r#9", live_runner_pid: 999 }),
    );

    await recoverFromCrash({
      taskStore,
      eventSpool,
      now: () => FIXED_NOW,
    });

    // A fresh drain should now find the daemon-restart we queued.
    const after = await eventSpool.drain();
    assert.equal(after.length, 1);
    assert.equal(after[0]!.event.kind, "daemon-restart");
    assert.equal(after[0]!.event.task_id, "github:o/r#9");
  });

  it("clears live_runner_pid after synthesizing the restart event", async () => {
    const root = tmpRoot();
    await ensureStateLayout(root);
    const taskStore = new TaskStore({ root });
    const eventSpool = new EventSpool({ root });

    await taskStore.write(
      task({ id: "github:o/r#1", live_runner_pid: 12345 }),
    );

    await recoverFromCrash({
      taskStore,
      eventSpool,
      now: () => FIXED_NOW,
    });

    const reloaded = await taskStore.read("github:o/r#1");
    assert.equal(reloaded?.live_runner_pid, null);
  });

  it("propagates last_known_stage from the task record when present", async () => {
    const root = tmpRoot();
    await ensureStateLayout(root);
    const taskStore = new TaskStore({ root });
    const eventSpool = new EventSpool({ root });

    // The TaskRecord type allows extra fields via the index signature.
    const t: TaskRecord = {
      ...task({ id: "github:o/r#1", live_runner_pid: 42 }),
      last_known_stage: "awaiting-ci",
    };
    await taskStore.write(t);

    const report = await recoverFromCrash({
      taskStore,
      eventSpool,
      now: () => FIXED_NOW,
    });

    assert.equal(report.synthesizedRestarts.length, 1);
    assert.equal(
      (report.synthesizedRestarts[0]!.payload as { last_known_stage?: string }).last_known_stage,
      "awaiting-ci",
    );
  });

  it("reports task IDs needing watch re-attachment", async () => {
    const root = tmpRoot();
    await ensureStateLayout(root);
    const taskStore = new TaskStore({ root });
    const eventSpool = new EventSpool({ root });

    await taskStore.write(
      task({
        id: "github:o/r#1",
        subscriptions: [{ source: "buildkite", id: "bk-1" } as never],
      }),
    );
    await taskStore.write(task({ id: "github:o/r#2", subscriptions: [] }));

    const report = await recoverFromCrash({
      taskStore,
      eventSpool,
      now: () => FIXED_NOW,
    });

    assert.deepEqual(report.taskIdsToReattach, ["github:o/r#1"]);
  });

  it("simulates kill -9: live runner + queued events + re-recovery is idempotent for state", async () => {
    const root = tmpRoot();
    await ensureStateLayout(root);
    const taskStore = new TaskStore({ root });
    const eventSpool = new EventSpool({ root });

    await taskStore.write(
      task({ id: "github:o/r#1", live_runner_pid: 7777 }),
    );
    await eventSpool.enqueue({
      kind: "pr-comment",
      task_id: "github:o/r#1",
      timestamp: "2026-05-15T09:00:00.000Z",
      payload: {},
    });

    // First recovery — simulates the daemon being kill -9'd mid-run.
    const r1 = await recoverFromCrash({
      taskStore,
      eventSpool,
      now: () => FIXED_NOW,
    });
    assert.equal(r1.replayedEvents.length, 1);
    assert.equal(r1.synthesizedRestarts.length, 1);

    // Second recovery — daemon restarts again immediately. The
    // first recovery already cleared live_runner_pid and drained
    // events, so no new daemon-restart should be synthesized.
    const r2 = await recoverFromCrash({
      taskStore,
      eventSpool,
      now: () => FIXED_NOW,
    });
    // Second recovery — daemon restarts again immediately. The
    // first recovery already cleared live_runner_pid, so no new
    // daemon-restart should be synthesized. drain() does NOT
    // dequeue (the daemon main loop dequeues after handling), so
    // r2 sees both the original pr-comment AND the daemon-restart
    // queued by r1 — that's the expected "resume the resume"
    // behaviour. What matters for idempotency is that no NEW
    // daemon-restart is synthesized.
    assert.equal(r2.synthesizedRestarts.length, 0);
    assert.equal(r2.replayedEvents.length, 2);
    assert.ok(r2.replayedEvents.some((e) => e.kind === "daemon-restart"));
  });
});
