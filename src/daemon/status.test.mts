import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { TaskRecord } from "../state/task-record.mts";
import {
  formatStatusTSV,
  type DaemonStatusSnapshot,
} from "./status.mts";

function task(over: Partial<TaskRecord> & { id: string }): TaskRecord {
  return {
    worktree: "/wt",
    head: "abc",
    session_id: "s",
    subscriptions: [],
    last_heartbeat: null,
    live_runner_pid: null,
    pending_followup: null,
    ...over,
  } as TaskRecord;
}

function snap(over: Partial<DaemonStatusSnapshot> = {}): DaemonStatusSnapshot {
  return {
    tasks: over.tasks ?? [],
    counters: over.counters ?? {
      eventsHandled: 0,
      runnersSpawned: 0,
      watchHandlesAlive: 0,
      pendingFollowups: 0,
    },
  };
}

describe("formatStatusTSV", () => {
  it("renders counters-only when no tasks are present", () => {
    const out = formatStatusTSV(
      snap({
        counters: {
          eventsHandled: 7,
          runnersSpawned: 3,
          watchHandlesAlive: 2,
          pendingFollowups: 1,
        },
      }),
    );
    assert.equal(
      out,
      ["events_handled\t7", "runners_spawned\t3", "watch_handles_alive\t2", "pending_followups\t1"].join("\n"),
    );
  });

  it("renders per-task lines followed by a blank line and counters", () => {
    const out = formatStatusTSV(
      snap({
        tasks: [
          task({
            id: "t-a",
            last_heartbeat: "2026-05-01T00:00:00Z",
            live_runner_pid: 1234,
          }),
        ],
      }),
    );
    const lines = out.split("\n");
    assert.equal(lines[0], "t-a\tworker\t2026-05-01T00:00:00Z\t1234");
    assert.equal(lines[1], "");
    assert.equal(lines[2], "events_handled\t0");
  });

  it("represents null heartbeat and pid as '-'", () => {
    const out = formatStatusTSV(
      snap({ tasks: [task({ id: "t-1" })] }),
    );
    assert.equal(out.split("\n")[0], "t-1\tworker\t-\t-");
  });

  it("sorts tasks by id for stable output", () => {
    const out = formatStatusTSV(
      snap({
        tasks: [task({ id: "z" }), task({ id: "a" }), task({ id: "m" })],
      }),
    );
    const ids = out.split("\n").slice(0, 3).map((l) => l.split("\t")[0]);
    assert.deepEqual(ids, ["a", "m", "z"]);
  });

  it("picks up a `role` field from the task record extras", () => {
    const t = task({ id: "t-1" });
    (t as { role?: unknown }).role = "watcher";
    const out = formatStatusTSV(snap({ tasks: [t] }));
    assert.equal(out.split("\n")[0]!.split("\t")[1], "watcher");
  });
});
