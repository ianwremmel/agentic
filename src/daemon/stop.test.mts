import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { DispatchError, ExitCode } from "../cli/errors.mts";
import {
  DEFAULT_STOP_POLL_MS,
  DEFAULT_STOP_TIMEOUT_MS,
  runDaemonStop,
  type DaemonStopDeps,
} from "./stop.mts";

interface FakeState {
  pid: number | null;
  alive: boolean;
  /** Becomes dead this many sleeps AFTER SIGTERM is sent. null = stays alive. */
  exitAfterSleeps: number | null;
  sleepCount: number;
  signalled: boolean;
  signals: { pid: number; signal: string }[];
  sleeps: number[];
}

function makeDeps(state: FakeState): DaemonStopDeps {
  return {
    readPidFile: () => state.pid,
    processExists: (pid) => {
      if (state.pid === null || pid !== state.pid) return false;
      if (
        state.signalled &&
        state.exitAfterSleeps !== null &&
        state.sleepCount >= state.exitAfterSleeps
      ) {
        return false;
      }
      return state.alive;
    },
    sendSignal: (pid, signal) => {
      state.signals.push({ pid, signal });
      state.signalled = true;
    },
    sleep: async (ms) => {
      state.sleeps.push(ms);
      state.sleepCount += 1;
    },
  };
}

function freshState(over: Partial<FakeState> = {}): FakeState {
  return {
    pid: 42,
    alive: true,
    exitAfterSleeps: null,
    sleepCount: 0,
    signalled: false,
    signals: [],
    sleeps: [],
    ...over,
  };
}

describe("runDaemonStop — no daemon", () => {
  it("throws PRECONDITION when pidfile is missing", async () => {
    const state = freshState({ pid: null });
    const deps = makeDeps(state);
    await assert.rejects(
      () => runDaemonStop(deps, { force: false }),
      (err: unknown) =>
        err instanceof DispatchError &&
        err.code === ExitCode.PRECONDITION &&
        err.message.includes("pidfile missing"),
    );
    assert.deepEqual(state.signals, []);
  });

  it("throws PRECONDITION when pidfile points to a dead pid", async () => {
    const state = freshState({ pid: 99, alive: false });
    const deps = makeDeps(state);
    await assert.rejects(
      () => runDaemonStop(deps, { force: false }),
      (err: unknown) =>
        err instanceof DispatchError &&
        err.code === ExitCode.PRECONDITION &&
        err.message.includes("stale pidfile"),
    );
    assert.deepEqual(state.signals, []);
  });
});

describe("runDaemonStop — graceful path", () => {
  it("sends SIGTERM then waits for exit", async () => {
    const state = freshState({ exitAfterSleeps: 3 });
    const deps = makeDeps(state);
    const r = await runDaemonStop(deps, {
      force: false,
      timeoutMs: 1000,
      pollMs: 10,
    });
    assert.deepEqual(state.signals, [{ pid: 42, signal: "SIGTERM" }]);
    assert.equal(r.exited, true);
    assert.equal(r.forced, false);
    assert.equal(r.pid, 42);
    assert.equal(state.sleepCount, 3);
    assert.equal(r.waitedMs, 30);
  });

  it("returns immediately if the daemon already exited between signal and first poll", async () => {
    // Process exits before any sleeps happen (exitAfterSleeps: 0
    // means already dead at first poll iteration check).
    const state = freshState({ exitAfterSleeps: 0 });
    const deps = makeDeps(state);
    const r = await runDaemonStop(deps, {
      force: false,
      timeoutMs: 1000,
      pollMs: 10,
    });
    assert.equal(r.exited, true);
    assert.equal(r.waitedMs, 0);
    assert.equal(state.sleepCount, 0);
  });

  it("throws GENERIC when the daemon does not exit within the timeout", async () => {
    const state = freshState({ exitAfterSleeps: null });
    const deps = makeDeps(state);
    await assert.rejects(
      () =>
        runDaemonStop(deps, {
          force: false,
          timeoutMs: 50,
          pollMs: 10,
        }),
      (err: unknown) =>
        err instanceof DispatchError &&
        err.code === ExitCode.GENERIC &&
        err.message.includes("did not exit within 50ms"),
    );
    assert.deepEqual(state.signals, [{ pid: 42, signal: "SIGTERM" }]);
  });
});

describe("runDaemonStop — force path", () => {
  it("--force sends SIGTERM and returns without waiting", async () => {
    const state = freshState();
    const deps = makeDeps(state);
    const r = await runDaemonStop(deps, { force: true });
    assert.deepEqual(state.signals, [{ pid: 42, signal: "SIGTERM" }]);
    assert.equal(r.forced, true);
    assert.equal(r.waitedMs, 0);
    assert.equal(state.sleepCount, 0);
    // The daemon is still alive (we didn't wait), so `exited`
    // reflects that.
    assert.equal(r.exited, false);
  });

  it("--force reports exited=true if the daemon happened to die instantly", async () => {
    const state = freshState({ exitAfterSleeps: 0 });
    const deps = makeDeps(state);
    const r = await runDaemonStop(deps, { force: true });
    assert.equal(r.exited, true);
    assert.equal(r.forced, true);
  });
});

describe("runDaemonStop — signal failure", () => {
  it("propagates sendSignal errors as DispatchError(GENERIC)", async () => {
    const state = freshState();
    const deps: DaemonStopDeps = {
      ...makeDeps(state),
      sendSignal: () => {
        throw new Error("EPERM");
      },
    };
    await assert.rejects(
      () => runDaemonStop(deps, { force: false }),
      (err: unknown) =>
        err instanceof DispatchError &&
        err.code === ExitCode.GENERIC &&
        err.message.includes("EPERM"),
    );
  });
});

describe("runDaemonStop — defaults", () => {
  it("DEFAULT_STOP_TIMEOUT_MS is 30 seconds per spec", () => {
    assert.equal(DEFAULT_STOP_TIMEOUT_MS, 30_000);
  });
  it("DEFAULT_STOP_POLL_MS is 100ms", () => {
    assert.equal(DEFAULT_STOP_POLL_MS, 100);
  });
});
