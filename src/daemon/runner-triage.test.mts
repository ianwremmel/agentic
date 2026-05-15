import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import type { DispatchEvent } from "../state/event.mts";
import {
  STREAM_TAIL_BYTES,
  tail,
  triageRunnerExit,
  type RunnerExit,
} from "./runner-triage.mts";

const TASK = { id: "owner/repo#42" };
const NOW = new Date("2026-06-01T12:34:56.000Z");
const ORIGINAL: DispatchEvent = {
  kind: "pr-comment",
  task_id: TASK.id,
  timestamp: "2026-06-01T12:34:55.000Z",
  payload: { comment_id: 1 },
};

function exit(over: Partial<RunnerExit> = {}): RunnerExit {
  return {
    exitCode: 1,
    signal: null,
    stdout: "",
    stderr: "",
    ...over,
  };
}

describe("triageRunnerExit hard-coded classifier", () => {
  it("classifies ENOENT spawn errors as runner-not-found → abort", () => {
    const d = triageRunnerExit({
      task: TASK,
      originalEvent: ORIGINAL,
      exit: exit({
        exitCode: null,
        spawnError: { code: "ENOENT", message: "no such file" },
      }),
      now: () => NOW,
    });
    assert.equal(d.kind, "abort");
    if (d.kind === "abort") assert.equal(d.reason, "runner-not-found");
  });

  it("classifies exit code 127 as runner-not-found → abort", () => {
    const d = triageRunnerExit({
      task: TASK,
      originalEvent: ORIGINAL,
      exit: exit({ exitCode: 127 }),
      now: () => NOW,
    });
    assert.equal(d.kind, "abort");
    if (d.kind === "abort") assert.equal(d.reason, "runner-not-found");
  });

  it("classifies exit code 2 / 64 as usage-error → abort", () => {
    for (const code of [2, 64]) {
      const d = triageRunnerExit({
        task: TASK,
        originalEvent: ORIGINAL,
        exit: exit({ exitCode: code }),
        now: () => NOW,
      });
      assert.equal(d.kind, "abort");
      if (d.kind === "abort") assert.equal(d.reason, "usage-error");
    }
  });

  it("classifies exit code 66 as prompt-resolution-failure → abort", () => {
    const d = triageRunnerExit({
      task: TASK,
      originalEvent: ORIGINAL,
      exit: exit({ exitCode: 66 }),
      now: () => NOW,
    });
    assert.equal(d.kind, "abort");
    if (d.kind === "abort") assert.equal(d.reason, "prompt-resolution-failure");
  });

  it("classifies exit code 137 as OOM → retry", () => {
    const d = triageRunnerExit({
      task: TASK,
      originalEvent: ORIGINAL,
      exit: exit({ exitCode: 137 }),
      now: () => NOW,
    });
    assert.equal(d.kind, "retry");
    if (d.kind === "retry") assert.equal(d.reason, "oom");
  });

  it("classifies SIGKILL with OOM stderr as OOM → retry", () => {
    const d = triageRunnerExit({
      task: TASK,
      originalEvent: ORIGINAL,
      exit: exit({
        exitCode: null,
        signal: "SIGKILL",
        stderr: "fatal: Out of memory: process killed",
      }),
      now: () => NOW,
    });
    assert.equal(d.kind, "retry");
    if (d.kind === "retry") assert.equal(d.reason, "oom");
  });
});

describe("triageRunnerExit runner-error synthesis", () => {
  it("synthesizes runner-error for unclassified non-zero exits, including tails and original payload", () => {
    const d = triageRunnerExit({
      task: TASK,
      originalEvent: ORIGINAL,
      exit: exit({
        exitCode: 17,
        stdout: "hello\n",
        stderr: "stack trace\nat …\n",
      }),
      now: () => NOW,
    });
    assert.equal(d.kind, "synthesize");
    if (d.kind !== "synthesize") return;
    assert.equal(d.event.kind, "runner-error");
    assert.equal(d.event.task_id, TASK.id);
    assert.equal(d.event.timestamp, NOW.toISOString());
    const p = d.event.payload as Record<string, unknown>;
    assert.equal(p.exit_code, 17);
    assert.equal(p.signal, null);
    assert.equal(p.stdout_tail, "hello\n");
    assert.equal(p.stderr_tail, "stack trace\nat …\n");
    assert.deepEqual(p.original_event, ORIGINAL);
  });

  it("never silently swallows the failure — synthesized event always preserves the original event", () => {
    const d = triageRunnerExit({
      task: TASK,
      originalEvent: ORIGINAL,
      exit: exit({ exitCode: 99 }),
      now: () => NOW,
    });
    assert.equal(d.kind, "synthesize");
    if (d.kind !== "synthesize") return;
    const p = d.event.payload as Record<string, unknown>;
    assert.deepEqual(p.original_event, ORIGINAL);
  });

  it("trims stdout/stderr tails to 64 KB and prefixes with an ellipsis", () => {
    const big = "x".repeat(STREAM_TAIL_BYTES + 100);
    const trimmed = tail(big, STREAM_TAIL_BYTES);
    assert.equal(trimmed.length, STREAM_TAIL_BYTES + 1);
    assert.equal(trimmed[0], "…");
  });

  it("tail() is a no-op when the input is already small enough", () => {
    assert.equal(tail("short", STREAM_TAIL_BYTES), "short");
  });
});
