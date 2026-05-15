import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  ConcurrencyGate,
  DEFAULT_MAX_LIVE_RUNNERS,
  TaskBusyError,
} from "./concurrency-gate.mts";

describe("ConcurrencyGate — construction", () => {
  it("defaults to 4 live runners per machine", () => {
    const g = new ConcurrencyGate();
    assert.equal(g.maxLiveRunners, DEFAULT_MAX_LIVE_RUNNERS);
    assert.equal(g.maxLiveRunners, 4);
  });

  it("rejects non-integer / non-positive caps", () => {
    assert.throws(() => new ConcurrencyGate({ maxLiveRunners: 0 }), RangeError);
    assert.throws(() => new ConcurrencyGate({ maxLiveRunners: -1 }), RangeError);
    assert.throws(() => new ConcurrencyGate({ maxLiveRunners: 2.5 }), RangeError);
  });
});

describe("ConcurrencyGate — per-task lock", () => {
  it("rejects a second acquire for the same task", async () => {
    const g = new ConcurrencyGate({ maxLiveRunners: 4 });
    await g.acquire("t1");
    await assert.rejects(g.acquire("t1"), TaskBusyError);
  });

  it("admits the same task again after release", async () => {
    const g = new ConcurrencyGate({ maxLiveRunners: 4 });
    const slot = await g.acquire("t1");
    slot.release();
    const slot2 = await g.acquire("t1");
    assert.ok(slot2);
  });

  it("release is idempotent", async () => {
    const g = new ConcurrencyGate({ maxLiveRunners: 4 });
    const slot = await g.acquire("t1");
    slot.release();
    slot.release(); // no-op
    assert.equal(g.liveCount(), 0);
  });
});

describe("ConcurrencyGate — machine-wide cap", () => {
  it("admits up to maxLiveRunners immediately", async () => {
    const g = new ConcurrencyGate({ maxLiveRunners: 2 });
    await g.acquire("a");
    await g.acquire("b");
    assert.equal(g.liveCount(), 2);
  });

  it("queues additional acquirers when cap is reached", async () => {
    const g = new ConcurrencyGate({ maxLiveRunners: 2 });
    const sA = await g.acquire("a");
    await g.acquire("b");
    const pC = g.acquire("c"); // queued
    assert.equal(g.waiterCount(), 1);
    assert.equal(g.liveCount(), 2);

    let admitted = false;
    void pC.then(() => {
      admitted = true;
    });
    // Yield twice to confirm c is not admitted before release.
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(admitted, false);

    sA.release();
    const sC = await pC;
    assert.equal(admitted, true);
    assert.equal(g.liveCount(), 2);
    assert.equal(g.waiterCount(), 0);
    sC.release();
  });

  it("admits FIFO order as slots open", async () => {
    const g = new ConcurrencyGate({ maxLiveRunners: 1 });
    const sA = await g.acquire("a");
    const order: string[] = [];
    const pB = g.acquire("b").then((s) => {
      order.push("b");
      return s;
    });
    const pC = g.acquire("c").then((s) => {
      order.push("c");
      return s;
    });
    const pD = g.acquire("d").then((s) => {
      order.push("d");
      return s;
    });

    sA.release();
    const sB = await pB;
    sB.release();
    const sC = await pC;
    sC.release();
    const sD = await pD;

    assert.deepEqual(order, ["b", "c", "d"]);
    sD.release();
  });

  it("does not admit beyond cap when one waiter resolves and another is queued", async () => {
    const g = new ConcurrencyGate({ maxLiveRunners: 2 });
    const sA = await g.acquire("a");
    const sB = await g.acquire("b");
    const pC = g.acquire("c");
    const pD = g.acquire("d");
    assert.equal(g.waiterCount(), 2);

    sA.release();
    const sC = await pC;
    assert.equal(g.liveCount(), 2);
    assert.equal(g.waiterCount(), 1);

    sB.release();
    const sD = await pD;
    assert.equal(g.liveCount(), 2);
    assert.equal(g.waiterCount(), 0);

    sC.release();
    sD.release();
    assert.equal(g.liveCount(), 0);
  });
});

describe("ConcurrencyGate — drainWaiters", () => {
  it("rejects every queued waiter with the provided reason", async () => {
    const g = new ConcurrencyGate({ maxLiveRunners: 1 });
    await g.acquire("a");
    const pB = g.acquire("b");
    const pC = g.acquire("c");

    const reason = new Error("daemon shutting down");
    g.drainWaiters(reason);

    await assert.rejects(pB, /daemon shutting down/);
    await assert.rejects(pC, /daemon shutting down/);
    assert.equal(g.waiterCount(), 0);
    // The live slot for 'a' is not released — caller tears down runners separately.
    assert.equal(g.liveCount(), 1);
  });
});

describe("ConcurrencyGate — introspection", () => {
  it("liveSnapshot returns a copy of currently-live task IDs", async () => {
    const g = new ConcurrencyGate({ maxLiveRunners: 4 });
    await g.acquire("a");
    await g.acquire("b");
    const snap = g.liveSnapshot();
    assert.deepEqual(snap.sort(), ["a", "b"]);
    snap.push("evil"); // mutating the snapshot doesn't affect the gate
    assert.equal(g.liveCount(), 2);
  });
});
