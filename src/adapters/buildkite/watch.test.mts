import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";

import { BuildkiteAdapterError } from "./errors.mts";
import { BuildkiteWatcher, type SpawnLike } from "./watch.mts";
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

const ARGS = { org: "acme", pipeline: "ci", buildNumber: 42 };

describe("BuildkiteWatcher.watchBuild", () => {
  it("yields events for each NDJSON line and terminates on passed", async () => {
    const child = fakeChild({
      lines: [
        JSON.stringify({ state: "running", number: 42 }),
        JSON.stringify({ state: "running", number: 42 }),
        JSON.stringify({ state: "passed", number: 42, url: "https://bk/1" }),
      ],
    });
    const w = new BuildkiteWatcher({
      spawn: spawnFactory(child),
      isAvailable: async () => true,
    });
    const events = [];
    for await (const e of w.watchBuild(ARGS)) events.push(e);
    assert.equal(events.length, 3);
    assert.equal(events.at(-1)?.state, "passed");
    assert.equal(events.at(-1)?.terminal, true);
    assert.equal(events.at(-1)?.url, "https://bk/1");
  });

  it("terminates on failed", async () => {
    const child = fakeChild({
      lines: [
        JSON.stringify({ state: "running" }),
        JSON.stringify({ state: "failed" }),
      ],
    });
    const w = new BuildkiteWatcher({
      spawn: spawnFactory(child),
      isAvailable: async () => true,
    });
    const events = [];
    for await (const e of w.watchBuild(ARGS)) events.push(e);
    assert.equal(events.at(-1)?.state, "failed");
    assert.equal(events.at(-1)?.terminal, true);
  });

  it("throws binary-not-found when bk is unavailable", async () => {
    const w = new BuildkiteWatcher({
      spawn: () => {
        throw new Error("should not spawn");
      },
      isAvailable: async () => false,
    });
    await assert.rejects(
      (async () => {
        for await (const _ of w.watchBuild(ARGS)) {
          // noop
        }
      })(),
      (err) => {
        assert.ok(err instanceof BuildkiteAdapterError);
        assert.equal((err as BuildkiteAdapterError).kind, "binary-not-found");
        return true;
      },
    );
  });

  it("throws parse-error on garbage output", async () => {
    const child = fakeChild({ lines: ["not json"] });
    const w = new BuildkiteWatcher({
      spawn: spawnFactory(child),
      isAvailable: async () => true,
    });
    await assert.rejects(
      (async () => {
        for await (const _ of w.watchBuild(ARGS)) {
          // noop
        }
      })(),
      (err) => {
        assert.equal((err as BuildkiteAdapterError).kind, "parse-error");
        return true;
      },
    );
  });

  it("throws subprocess-crashed when child exits non-zero before terminal", async () => {
    const child = fakeChild({
      lines: [JSON.stringify({ state: "running" })],
      exitCode: 2,
    });
    const w = new BuildkiteWatcher({
      spawn: spawnFactory(child),
      isAvailable: async () => true,
    });
    await assert.rejects(
      (async () => {
        for await (const _ of w.watchBuild(ARGS)) {
          // noop
        }
      })(),
      (err) => {
        assert.equal((err as BuildkiteAdapterError).kind, "subprocess-crashed");
        assert.equal((err as BuildkiteAdapterError).exitCode, 2);
        return true;
      },
    );
  });

  it("ignores empty lines", async () => {
    const child = fakeChild({
      lines: ["", JSON.stringify({ state: "passed" })],
    });
    const w = new BuildkiteWatcher({
      spawn: spawnFactory(child),
      isAvailable: async () => true,
    });
    const events = [];
    for await (const e of w.watchBuild(ARGS)) events.push(e);
    assert.equal(events.length, 1);
  });
});
