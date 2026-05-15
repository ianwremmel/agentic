import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { acquirePidLock, EXIT_HELD } from "./pid-lock.mts";

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "dispatch-pidlock-"));
}

describe("acquirePidLock", () => {
  it("creates the file with our PID and registers cleanup", () => {
    const dir = freshDir();
    const pidFile = join(dir, "daemon.pid");
    let registered: (() => void) | null = null;
    const r = acquirePidLock({
      pidFile,
      pid: 12345,
      isAlive: () => true,
      registerCleanup: (cb) => {
        registered = cb;
      },
    });
    assert.equal(r.ok, true);
    assert.equal(readFileSync(pidFile, "utf8").trim(), "12345");
    assert.ok(registered, "cleanup should be registered");
    registered!();
    assert.equal(existsSync(pidFile), false);
  });

  it("refuses to start when held by a live process", () => {
    const dir = freshDir();
    const pidFile = join(dir, "daemon.pid");
    writeFileSync(pidFile, "9999\n");
    const r = acquirePidLock({
      pidFile,
      pid: 1,
      isAlive: (pid) => pid === 9999,
      registerCleanup: () => {},
    });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.reason, "held");
      assert.equal(r.holderPid, 9999);
    }
  });

  it("recovers a stale lockfile when the recorded PID is gone", () => {
    const dir = freshDir();
    const pidFile = join(dir, "daemon.pid");
    writeFileSync(pidFile, "9999\n");
    const r = acquirePidLock({
      pidFile,
      pid: 42,
      isAlive: () => false,
      registerCleanup: () => {},
    });
    assert.equal(r.ok, true);
    assert.equal(readFileSync(pidFile, "utf8").trim(), "42");
  });

  it("treats EPERM (un-signalable PID) as live via defaultIsAlive — the injected isAlive simply returns true", () => {
    const dir = freshDir();
    const pidFile = join(dir, "daemon.pid");
    writeFileSync(pidFile, "1\n");
    const r = acquirePidLock({
      pidFile,
      pid: 42,
      isAlive: (pid) => pid === 1,
      registerCleanup: () => {},
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.holderPid, 1);
  });

  it("creates intermediate state directory", () => {
    const dir = freshDir();
    const pidFile = join(dir, "nested", "deep", "daemon.pid");
    const r = acquirePidLock({
      pidFile,
      pid: 7,
      isAlive: () => true,
      registerCleanup: () => {},
    });
    assert.equal(r.ok, true);
    assert.equal(readFileSync(pidFile, "utf8").trim(), "7");
  });

  it("release is idempotent", () => {
    const dir = freshDir();
    const pidFile = join(dir, "daemon.pid");
    const r = acquirePidLock({
      pidFile,
      pid: 5,
      isAlive: () => true,
      registerCleanup: () => {},
    });
    assert.equal(r.ok, true);
    if (r.ok) {
      r.release();
      // Second call must not throw.
      r.release();
    }
  });

  it("ignores empty/garbage pidfile content as stale", () => {
    const dir = freshDir();
    const pidFile = join(dir, "daemon.pid");
    writeFileSync(pidFile, "not-a-number\n");
    const r = acquirePidLock({
      pidFile,
      pid: 99,
      isAlive: () => {
        throw new Error("should not be called on garbage content");
      },
      registerCleanup: () => {},
    });
    assert.equal(r.ok, true);
    assert.equal(readFileSync(pidFile, "utf8").trim(), "99");
  });

  it("exposes EXIT_HELD = 4 for callers", () => {
    assert.equal(EXIT_HELD, 4);
  });
});
