import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ipcRequest, IpcConnectError, startIpcServer } from "./ipc.mts";
import type { DaemonStatusSnapshot } from "./status.mts";

async function tmpSock(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "dispatch-ipc-"));
  return join(dir, "daemon.sock");
}

function emptySnapshot(): DaemonStatusSnapshot {
  return {
    tasks: [],
    counters: {
      eventsHandled: 0,
      runnersSpawned: 0,
      watchHandlesAlive: 0,
      pendingFollowups: 0,
    },
  };
}

describe("ipc — startIpcServer + ipcRequest", () => {
  it("status round-trip returns the snapshot from the server", async () => {
    const sock = await tmpSock();
    const snap: DaemonStatusSnapshot = {
      tasks: [],
      counters: {
        eventsHandled: 5,
        runnersSpawned: 2,
        watchHandlesAlive: 1,
        pendingFollowups: 0,
      },
    };
    const server = await startIpcServer({ sockFile: sock, getStatus: () => snap });
    try {
      const res = await ipcRequest(sock, { op: "status" });
      assert.equal(res.ok, true);
      if (res.ok) {
        assert.deepEqual(res.snapshot, snap);
      }
    } finally {
      await server.close();
      await rm(join(sock, ".."), { recursive: true, force: true });
    }
  });

  it("unknown op yields an ok:false response with a useful error", async () => {
    const sock = await tmpSock();
    const server = await startIpcServer({
      sockFile: sock,
      getStatus: () => emptySnapshot(),
    });
    try {
      // We intentionally bypass the typed wrapper to send a bogus op.
      const res = (await ipcRequest(sock, { op: "nope" as "status" })) as
        | { ok: true }
        | { ok: false; error: string };
      assert.equal(res.ok, false);
      if (!res.ok) {
        assert.ok(res.error.includes("nope"));
      }
    } finally {
      await server.close();
      await rm(join(sock, ".."), { recursive: true, force: true });
    }
  });

  it("propagates getStatus failures as ok:false responses", async () => {
    const sock = await tmpSock();
    const server = await startIpcServer({
      sockFile: sock,
      getStatus: () => {
        throw new Error("boom");
      },
    });
    try {
      const res = await ipcRequest(sock, { op: "status" });
      assert.equal(res.ok, false);
      if (!res.ok) assert.equal(res.error, "boom");
    } finally {
      await server.close();
      await rm(join(sock, ".."), { recursive: true, force: true });
    }
  });

  it("requests to a missing socket throw IpcConnectError(ENOENT)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dispatch-ipc-missing-"));
    const sock = join(dir, "nope.sock");
    try {
      await assert.rejects(
        () => ipcRequest(sock, { op: "status" }),
        (err: unknown) =>
          err instanceof IpcConnectError && err.code === "ENOENT",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("startIpcServer unlinks a stale socket before binding", async () => {
    const sock = await tmpSock();
    // First server creates the socket file.
    const s1 = await startIpcServer({
      sockFile: sock,
      getStatus: () => emptySnapshot(),
    });
    // Simulate a stale socket by *not* calling close().
    // The second start must succeed despite the existing file.
    // (We bypass the typical "PID lock holds singleton" precondition
    // here because the test directly exercises the unlink path.)
    // First close the running server to release the FD; the file
    // remains because close() unlinks it — so seed it manually.
    await s1.close();
    // Recreate the lingering socket-style file manually.
    const { writeFile } = await import("node:fs/promises");
    await writeFile(sock, "", "utf8");
    const s2 = await startIpcServer({
      sockFile: sock,
      getStatus: () => emptySnapshot(),
    });
    try {
      const res = await ipcRequest(sock, { op: "status" });
      assert.equal(res.ok, true);
    } finally {
      await s2.close();
      await rm(join(sock, ".."), { recursive: true, force: true });
    }
  });
});
