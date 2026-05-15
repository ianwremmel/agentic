import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";

import { ActionsAdapterError } from "./errors.mts";
import { ActionsWatcher, type SpawnLike } from "./watch.mts";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

interface FakeChildOpts {
  lines: string[];
  exitCode?: number;
  exitSignal?: NodeJS.Signals | null;
}

function fakeChild(opts: FakeChildOpts): ChildProcessWithoutNullStreams {
  const stdout = Readable.from(
    (async function* () {
      for (const line of opts.lines) {
        yield `${line}\n`;
      }
    })(),
  );
  const stderr = new Readable({
    read() {
      this.push(null);
    },
  });
  const stdin = new Writable({
    write(_c, _e, cb) {
      cb();
    },
  });
  const child = new EventEmitter() as ChildProcessWithoutNullStreams & {
    exitCode: number | null;
    killed: boolean;
    stdout: NodeJS.ReadableStream;
    stderr: NodeJS.ReadableStream;
    stdin: NodeJS.WritableStream;
    kill: () => boolean;
  };
  child.stdout = stdout;
  child.stderr = stderr;
  child.stdin = stdin;
  child.exitCode = null;
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    return true;
  };
  stdout.on("end", () => {
    const code = opts.exitCode ?? 0;
    child.exitCode = code;
    queueMicrotask(() => child.emit("exit", code, opts.exitSignal ?? null));
  });
  return child;
}

function spawnFactory(child: ChildProcessWithoutNullStreams): SpawnLike {
  return () => child;
}

const ARGS = { repo: "ianwremmel/agentic", prNumber: 42 };

describe("ActionsWatcher.watchChecks", () => {
  it("emits a pending snapshot then a terminal success snapshot", async () => {
    const pending = JSON.stringify([
      { bucket: "pending", name: "build" },
      { bucket: "pass", name: "lint" },
    ]);
    const passing = JSON.stringify([
      { bucket: "pass", name: "build" },
      { bucket: "pass", name: "lint" },
    ]);
    const child = fakeChild({ lines: [pending, passing] });
    const w = new ActionsWatcher({
      spawn: spawnFactory(child),
      isAvailable: async () => true,
    });
    const events = [];
    for await (const e of w.watchChecks(ARGS)) events.push(e);
    assert.equal(events.length, 2);
    assert.equal(events[0].state, "pending");
    assert.equal(events[0].terminal, false);
    assert.equal(events[1].state, "success");
    assert.equal(events[1].terminal, true);
  });

  it("emits a terminal failure snapshot when any check is in the fail bucket", async () => {
    const snap = JSON.stringify([
      { bucket: "pass", name: "lint" },
      { bucket: "fail", name: "test" },
    ]);
    const child = fakeChild({ lines: [snap] });
    const w = new ActionsWatcher({
      spawn: spawnFactory(child),
      isAvailable: async () => true,
    });
    const events = [];
    for await (const e of w.watchChecks(ARGS)) events.push(e);
    assert.equal(events.at(-1)?.state, "failure");
    assert.equal(events.at(-1)?.terminal, true);
  });

  it("throws binary-not-found when gh is unavailable", async () => {
    const w = new ActionsWatcher({
      spawn: () => {
        throw new Error("should not spawn");
      },
      isAvailable: async () => false,
    });
    await assert.rejects(
      (async () => {
        for await (const _ of w.watchChecks(ARGS)) {
          // noop
        }
      })(),
      (err) => {
        assert.ok(err instanceof ActionsAdapterError);
        assert.equal((err as ActionsAdapterError).kind, "binary-not-found");
        return true;
      },
    );
  });

  it("accepts pretty-printed JSON spread across multiple lines", async () => {
    const pretty = JSON.stringify(
      [{ bucket: "pass", name: "build" }],
      null,
      2,
    ).split("\n");
    const child = fakeChild({ lines: pretty });
    const w = new ActionsWatcher({
      spawn: spawnFactory(child),
      isAvailable: async () => true,
    });
    const events = [];
    for await (const e of w.watchChecks(ARGS)) events.push(e);
    assert.equal(events.length, 1);
    assert.equal(events[0].state, "success");
  });

  it("throws parse-error when stdout ends with an unterminated buffer", async () => {
    const child = fakeChild({ lines: ["{not json"], exitCode: 0 });
    const w = new ActionsWatcher({
      spawn: spawnFactory(child),
      isAvailable: async () => true,
    });
    await assert.rejects(
      (async () => {
        for await (const _ of w.watchChecks(ARGS)) {
          // noop
        }
      })(),
      (err) => {
        assert.equal((err as ActionsAdapterError).kind, "parse-error");
        return true;
      },
    );
  });

  it("throws subprocess-crashed when gh exits non-zero before terminal", async () => {
    const pending = JSON.stringify([{ bucket: "pending", name: "x" }]);
    const child = fakeChild({ lines: [pending], exitCode: 1 });
    const w = new ActionsWatcher({
      spawn: spawnFactory(child),
      isAvailable: async () => true,
    });
    await assert.rejects(
      (async () => {
        for await (const _ of w.watchChecks(ARGS)) {
          // noop
        }
      })(),
      (err) => {
        assert.equal((err as ActionsAdapterError).kind, "subprocess-crashed");
        assert.equal((err as ActionsAdapterError).exitCode, 1);
        return true;
      },
    );
  });
});
