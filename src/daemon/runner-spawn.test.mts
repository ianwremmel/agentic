import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ChildProcessWithoutNullStreams } from "node:child_process";

import { DEFAULT_RUNNER } from "../config/schema.mts";
import {
  RunnerSpawnError,
  RunnerSpawner,
  type RunnerLogSink,
  type SpawnLike,
} from "./runner-spawn.mts";

interface FakeChildOpts {
  stdout?: string[];
  stderr?: string[];
  exitCode?: number;
}

function fakeChild(opts: FakeChildOpts): ChildProcessWithoutNullStreams {
  const stdout = Readable.from(
    (async function* () {
      for (const line of opts.stdout ?? []) yield `${line}\n`;
    })(),
  );
  const stderr = Readable.from(
    (async function* () {
      for (const line of opts.stderr ?? []) yield `${line}\n`;
    })(),
  );
  const stdin = new Writable({
    write(_c, _e, cb) {
      cb();
    },
  });
  const child = new EventEmitter() as ChildProcessWithoutNullStreams & {
    stdout: NodeJS.ReadableStream;
    stderr: NodeJS.ReadableStream;
    stdin: NodeJS.WritableStream;
    pid: number;
    exitCode: number | null;
    killed: boolean;
    kill: () => boolean;
  };
  child.stdout = stdout;
  child.stderr = stderr;
  child.stdin = stdin;
  child.pid = 4242;
  child.exitCode = null;
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    return true;
  };
  const code = opts.exitCode ?? 0;
  let stdoutDone = false;
  let stderrDone = false;
  const maybeExit = (): void => {
    if (stdoutDone && stderrDone) {
      child.exitCode = code;
      queueMicrotask(() => child.emit("exit", code, null));
    }
  };
  stdout.on("end", () => {
    stdoutDone = true;
    maybeExit();
  });
  stderr.on("end", () => {
    stderrDone = true;
    maybeExit();
  });
  return child;
}

function recordingSink(): RunnerLogSink & {
  lines: Array<{ stream: "stdout" | "stderr"; line: string }>;
} {
  const lines: Array<{ stream: "stdout" | "stderr"; line: string }> = [];
  return {
    lines,
    write(stream, line) {
      lines.push({ stream, line });
    },
  };
}

async function makeWorktree(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "dispatch-spawn-"));
  await mkdir(dir, { recursive: true });
  return dir;
}

describe("RunnerSpawner.spawnRunner", () => {
  it("invokes the runner without a resume flag on first spawn and captures the session ID from stdout", async () => {
    const wt = await makeWorktree();
    try {
      const captured: {
        value: { command: string; args: readonly string[]; cwd: string } | null;
      } = { value: null };
      const spawn: SpawnLike = (command, args, options) => {
        captured.value = { command, args, cwd: options.cwd };
        return fakeChild({
          stdout: [
            "starting runner",
            JSON.stringify({ session_id: "sess-abc-123" }),
            "ok",
          ],
        });
      };
      const log = recordingSink();
      const spawner = new RunnerSpawner({
        runner: { ...DEFAULT_RUNNER, extraArgs: ["--allow-network"] },
        spawn,
        log,
      });
      const result = await spawner.spawnRunner({
        task: { id: "owner/repo#42", worktree: wt },
        eventKind: "bootstrap",
        eventPayloadPath: "/var/dispatch/events/x.json",
        promptFile: "/var/dispatch/prompts/p.md",
        isResume: false,
      });
      assert.equal(result.exitCode, 0);
      assert.equal(result.sessionId, "sess-abc-123");
      assert.equal(result.pid, 4242);

      assert.ok(captured.value, "spawn should have been called");
      assert.equal(captured.value.command, "claude");
      assert.equal(captured.value.cwd, wt);
      assert.deepEqual(captured.value.args, [
        "--allow-network",
        "--cwd",
        wt,
        "--prompt-file",
        "/var/dispatch/prompts/p.md",
        "--env",
        "DISPATCH_TASK_ID=owner/repo#42",
        "--env",
        "DISPATCH_EVENT=bootstrap",
        "--env",
        "DISPATCH_EVENT_PAYLOAD=/var/dispatch/events/x.json",
      ]);
      assert.ok(
        log.lines.some(
          (l) => l.stream === "stdout" && l.line.includes("sess-abc-123"),
        ),
        "session-id line should be tee'd to the log sink too",
      );
    } finally {
      await rm(wt, { recursive: true, force: true });
    }
  });

  it("passes the resume flag + stored session ID on subsequent spawns", async () => {
    const wt = await makeWorktree();
    try {
      const captured: { value: { args: readonly string[] } | null } = {
        value: null,
      };
      const spawn: SpawnLike = (_command, args) => {
        captured.value = { args };
        return fakeChild({ stdout: ["resumed"] });
      };
      const spawner = new RunnerSpawner({
        runner: DEFAULT_RUNNER,
        spawn,
        log: recordingSink(),
      });
      const result = await spawner.spawnRunner({
        task: { id: "t1", worktree: wt, sessionId: "sess-old" },
        eventKind: "pr-comment",
        eventPayloadPath: "/e.json",
        promptFile: "/p.md",
        isResume: true,
      });
      assert.equal(result.exitCode, 0);
      assert.equal(result.sessionId, null);
      assert.ok(captured.value);
      assert.deepEqual(captured.value.args.slice(0, 2), [
        "--resume",
        "sess-old",
      ]);
    } finally {
      await rm(wt, { recursive: true, force: true });
    }
  });

  it("captures the session ID from stderr when session_id_capture is stderr-jsonline", async () => {
    const wt = await makeWorktree();
    try {
      const spawn: SpawnLike = () =>
        fakeChild({
          stdout: ["plain text on stdout — should be ignored for capture"],
          stderr: [JSON.stringify({ sessionId: "sess-from-stderr" })],
        });
      const spawner = new RunnerSpawner({
        runner: { ...DEFAULT_RUNNER, sessionIdCapture: "stderr-jsonline" },
        spawn,
        log: recordingSink(),
      });
      const result = await spawner.spawnRunner({
        task: { id: "t", worktree: wt },
        eventKind: "bootstrap",
        eventPayloadPath: "/e.json",
        promptFile: "/p.md",
        isResume: false,
      });
      assert.equal(result.sessionId, "sess-from-stderr");
    } finally {
      await rm(wt, { recursive: true, force: true });
    }
  });

  it("throws worktree-missing when the worktree does not exist", async () => {
    const spawner = new RunnerSpawner({
      runner: DEFAULT_RUNNER,
      spawn: () => {
        throw new Error("should not spawn");
      },
      log: recordingSink(),
      worktreeExists: async () => false,
    });
    await assert.rejects(
      spawner.spawnRunner({
        task: { id: "t", worktree: "/nope" },
        eventKind: "bootstrap",
        eventPayloadPath: "/e.json",
        promptFile: "/p.md",
        isResume: false,
      }),
      (err) => {
        assert.ok(err instanceof RunnerSpawnError);
        assert.equal((err as RunnerSpawnError).kind, "worktree-missing");
        return true;
      },
    );
  });

  it("throws missing-session-id when resuming without a stored session ID", async () => {
    const wt = await makeWorktree();
    try {
      const spawner = new RunnerSpawner({
        runner: DEFAULT_RUNNER,
        spawn: () => {
          throw new Error("should not spawn");
        },
        log: recordingSink(),
      });
      await assert.rejects(
        spawner.spawnRunner({
          task: { id: "t", worktree: wt, sessionId: null },
          eventKind: "pr-comment",
          eventPayloadPath: "/e.json",
          promptFile: "/p.md",
          isResume: true,
        }),
        (err) => {
          assert.equal((err as RunnerSpawnError).kind, "missing-session-id");
          return true;
        },
      );
    } finally {
      await rm(wt, { recursive: true, force: true });
    }
  });

  it("throws no-session-id-captured when a first spawn exits 0 without emitting one", async () => {
    const wt = await makeWorktree();
    try {
      const spawn: SpawnLike = () =>
        fakeChild({ stdout: ["chatty but no JSON"] });
      const spawner = new RunnerSpawner({
        runner: DEFAULT_RUNNER,
        spawn,
        log: recordingSink(),
      });
      await assert.rejects(
        spawner.spawnRunner({
          task: { id: "t", worktree: wt },
          eventKind: "bootstrap",
          eventPayloadPath: "/e.json",
          promptFile: "/p.md",
          isResume: false,
        }),
        (err) => {
          assert.equal(
            (err as RunnerSpawnError).kind,
            "no-session-id-captured",
          );
          return true;
        },
      );
    } finally {
      await rm(wt, { recursive: true, force: true });
    }
  });

  it("returns the non-zero exit code without throwing (triage is handled by #40)", async () => {
    const wt = await makeWorktree();
    try {
      const spawn: SpawnLike = () =>
        fakeChild({ stderr: ["boom"], exitCode: 42 });
      const spawner = new RunnerSpawner({
        runner: DEFAULT_RUNNER,
        spawn,
        log: recordingSink(),
      });
      const result = await spawner.spawnRunner({
        task: { id: "t", worktree: wt, sessionId: "s" },
        eventKind: "pr-comment",
        eventPayloadPath: "/e.json",
        promptFile: "/p.md",
        isResume: true,
      });
      assert.equal(result.exitCode, 42);
      assert.equal(result.sessionId, null);
    } finally {
      await rm(wt, { recursive: true, force: true });
    }
  });
});
