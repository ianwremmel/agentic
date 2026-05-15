import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DispatchError, ExitCode } from "../cli/errors.mts";
import { EventSpool } from "../state/event-spool.mts";
import { encodeTaskId } from "../state/encoding.mts";
import { ensureStateLayout } from "../state/paths.mts";
import { openTaskStore } from "../state/task-store.mts";
import { buildBaseProbes } from "./preflight.mts";
import { runDaemonStart, type DaemonStartDeps } from "./start.mts";

async function tempStateDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "dispatch-start-"));
  ensureStateLayout({ root: d });
  return d;
}

function lockHeld(holderPid: number) {
  return () => ({ ok: false as const, reason: "held" as const, holderPid });
}

function lockOk(release: () => void = () => {}) {
  return () => ({ ok: true as const, release, pidFile: "/dev/null" });
}

function okRunner() {
  return async () => ({ exitCode: 0 });
}

function makeRecovery(root: string) {
  return {
    taskStore: openTaskStore({ root }),
    eventSpool: new EventSpool({ root }),
    now: () => "2026-05-15T12:00:00.000Z",
  };
}

function baseDeps(over: Partial<DaemonStartDeps> & { root: string }): DaemonStartDeps {
  return {
    acquireLock: over.acquireLock ?? lockOk(),
    probes: over.probes ?? buildBaseProbes({ runnerBin: "claude" }),
    runProbe: over.runProbe ?? okRunner(),
    recovery: over.recovery ?? makeRecovery(over.root),
    reattachWatches: over.reattachWatches ?? (async () => {}),
    startPollingLoop: over.startPollingLoop ?? (() => {}),
    detach: over.detach ?? (() => {}),
  };
}

describe("runDaemonStart — happy path on a cold state dir", () => {
  it("acquires the lock, preflights, recovers (empty), and starts loop", async () => {
    const root = await tempStateDir();
    const calls: string[] = [];
    const report = await runDaemonStart(
      baseDeps({
        root,
        acquireLock: () => {
          calls.push("lock");
          return { ok: true, release: () => calls.push("release"), pidFile: "x" };
        },
        runProbe: async () => {
          calls.push("probe");
          return { exitCode: 0 };
        },
        reattachWatches: async (ids) => {
          calls.push(`reattach:${ids.join(",")}`);
        },
        startPollingLoop: () => calls.push("poll"),
        detach: () => calls.push("detach"),
      }),
      { foreground: false },
    );
    assert.equal(report.ok, true);
    assert.equal(report.detached, true);
    assert.equal(report.recovery.tasks, 0);
    assert.equal(report.recovery.replayedEvents.length, 0);
    // Sequence: lock → probes → poll → detach (no reattach because no tasks)
    assert.equal(calls[0], "lock");
    assert.equal(calls.filter((c) => c === "probe").length, 4);
    assert.ok(calls.indexOf("poll") > calls.lastIndexOf("probe"));
    assert.ok(calls.indexOf("detach") > calls.indexOf("poll"));
    assert.ok(!calls.includes("release"));
  });

  it("skips detach when --foreground", async () => {
    const root = await tempStateDir();
    let detached = false;
    const report = await runDaemonStart(
      baseDeps({ root, detach: () => (detached = true) }),
      { foreground: true },
    );
    assert.equal(report.detached, false);
    assert.equal(detached, false);
  });
});

describe("runDaemonStart — lock contention", () => {
  it("throws DispatchError(PRECONDITION) when the lock is held", async () => {
    const root = await tempStateDir();
    await assert.rejects(
      () =>
        runDaemonStart(baseDeps({ root, acquireLock: lockHeld(9999) }), {
          foreground: true,
        }),
      (err: unknown) => {
        assert.ok(err instanceof DispatchError);
        assert.equal((err as DispatchError).code, ExitCode.PRECONDITION);
        assert.match((err as DispatchError).message, /pid 9999/);
        return true;
      },
    );
  });

  it("does not run preflight when the lock is held", async () => {
    const root = await tempStateDir();
    let probeRan = false;
    await assert.rejects(() =>
      runDaemonStart(
        baseDeps({
          root,
          acquireLock: lockHeld(123),
          runProbe: async () => {
            probeRan = true;
            return { exitCode: 0 };
          },
        }),
        { foreground: true },
      ),
    );
    assert.equal(probeRan, false);
  });
});

describe("runDaemonStart — preflight failure", () => {
  it("throws DispatchError(PRECONDITION) and releases the lock", async () => {
    const root = await tempStateDir();
    let released = false;
    await assert.rejects(
      () =>
        runDaemonStart(
          baseDeps({
            root,
            acquireLock: lockOk(() => (released = true)),
            probes: [
              { name: "git", argv: ["git", "--version"], asserts: "present" },
            ],
            runProbe: async () => ({ exitCode: 127, reason: "command not found" }),
          }),
          { foreground: true },
        ),
      (err: unknown) => {
        assert.ok(err instanceof DispatchError);
        assert.equal((err as DispatchError).code, ExitCode.PRECONDITION);
        assert.match(
          (err as DispatchError).message,
          /required CLI checks failed[\s\S]+git/,
        );
        return true;
      },
    );
    assert.equal(released, true);
  });

  it("does not begin polling when preflight fails", async () => {
    const root = await tempStateDir();
    let polled = false;
    await assert.rejects(() =>
      runDaemonStart(
        baseDeps({
          root,
          probes: [{ name: "git", argv: ["git", "--version"], asserts: "present" }],
          runProbe: async () => ({ exitCode: 1 }),
          startPollingLoop: () => (polled = true),
        }),
        { foreground: true },
      ),
    );
    assert.equal(polled, false);
  });
});

describe("runDaemonStart — recovery integration", () => {
  it("synthesizes daemon-restart for a task with live_runner_pid, then re-attaches", async () => {
    const root = await tempStateDir();
    // Seed a task with a live runner PID and a subscription so the
    // recovery module reports it for re-attach.
    const taskRec = {
      id: "t-1",
      worktree: "/wt",
      head: "abc",
      session_id: "s",
      subscriptions: ["pr:owner/repo#1"],
      last_heartbeat: null,
      live_runner_pid: 4242,
      pending_followup: null,
      last_known_stage: "running",
    };
    await writeFile(
      join(root, "tasks", `${encodeTaskId("t-1")}.json`),
      JSON.stringify(taskRec, null, 2),
      "utf8",
    );

    const reattached: string[][] = [];
    const report = await runDaemonStart(
      baseDeps({
        root,
        reattachWatches: async (ids) => {
          reattached.push([...ids]);
        },
      }),
      { foreground: true },
    );
    assert.equal(report.recovery.tasks, 1);
    assert.equal(report.recovery.synthesizedRestarts.length, 1);
    assert.equal(report.recovery.synthesizedRestarts[0].kind, "daemon-restart");
    assert.deepEqual(reattached, [["t-1"]]);
  });

  it("does not re-attach when there are no tasks needing it", async () => {
    const root = await tempStateDir();
    let called = false;
    await runDaemonStart(
      baseDeps({
        root,
        reattachWatches: async () => {
          called = true;
        },
      }),
      { foreground: true },
    );
    assert.equal(called, false);
  });
});

describe("runDaemonStart — error after lock release", () => {
  it("releases the lock if reattach throws", async () => {
    const root = await tempStateDir();
    // Seed one task with live_runner_pid so reattach is called.
    const taskRec = {
      id: "t-x",
      worktree: "/wt",
      head: "h",
      session_id: "s",
      subscriptions: [{ source: "github", target: "ianwremmel/agentic#1" }],
      last_heartbeat: null,
      live_runner_pid: 1,
      pending_followup: null,
    };
    await writeFile(
      join(root, "tasks", `${encodeTaskId("t-x")}.json`),
      JSON.stringify(taskRec, null, 2),
      "utf8",
    );

    let released = false;
    await assert.rejects(() =>
      runDaemonStart(
        baseDeps({
          root,
          acquireLock: lockOk(() => (released = true)),
          reattachWatches: async () => {
            throw new Error("watch attach failed");
          },
        }),
        { foreground: true },
      ),
    );
    assert.equal(released, true);
  });
});
