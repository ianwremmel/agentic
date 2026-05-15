import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
  buildEventFilename,
  openEventSpool,
  parseEventFilename,
} from "./event-spool.mts";
import { ensureStateLayout } from "./paths.mts";
import type { DispatchEvent } from "./event.mts";

function freshRoot(): string {
  return mkdtempSync(join(tmpdir(), "dispatch-spool-"));
}

function event(over: Partial<DispatchEvent> = {}): DispatchEvent {
  return {
    kind: "heartbeat",
    task_id: "github:owner/repo#1",
    timestamp: "2026-05-15T12:00:00.000Z",
    payload: {},
    ...over,
  };
}

describe("buildEventFilename / parseEventFilename", () => {
  it("round-trips a github task ID", () => {
    const fn = buildEventFilename(
      "2026-05-15T12:00:00.000Z",
      "github:owner/repo#1",
    );
    assert.equal(fn, "2026-05-15T12:00:00.000Z-github%3aowner%2frepo%231.json");
    assert.deepEqual(parseEventFilename(fn), {
      timestamp: "2026-05-15T12:00:00.000Z",
      taskId: "github:owner/repo#1",
    });
  });

  it("rejects filenames missing the .json extension", () => {
    assert.throws(() => parseEventFilename("2026-05-15T12:00:00Z-x"), /\.json/);
  });

  it("rejects filenames without the Z- separator", () => {
    assert.throws(() => parseEventFilename("garbage.json"), /Z-/);
  });

  it("rejects non-RFC3339 timestamps", () => {
    assert.throws(
      () => parseEventFilename("notatimestampZ-abc.json"),
      /RFC 3339/,
    );
  });
});

describe("EventSpool", () => {
  let dir: string;

  beforeEach(() => {
    dir = freshRoot();
    ensureStateLayout({ root: dir });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("enqueue writes to events/<ts>-<encoded-id>.json", async () => {
    const spool = openEventSpool({ root: dir });
    const name = await spool.enqueue(event());

    assert.equal(
      name,
      "2026-05-15T12:00:00.000Z-github%3aowner%2frepo%231.json",
    );
    assert.equal(existsSync(spool.pathFor(name)), true);
  });

  it("drain() returns events in chronological order", async () => {
    const spool = openEventSpool({ root: dir });

    await spool.enqueue(event({ timestamp: "2026-05-15T12:00:02.000Z" }));
    await spool.enqueue(
      event({ timestamp: "2026-05-15T12:00:00.000Z", task_id: "linear:t#1" }),
    );
    await spool.enqueue(event({ timestamp: "2026-05-15T12:00:01.000Z" }));

    const drained = await spool.drain();
    const tss = drained.map((e) => e.event.timestamp);
    assert.deepEqual(tss, [
      "2026-05-15T12:00:00.000Z",
      "2026-05-15T12:00:01.000Z",
      "2026-05-15T12:00:02.000Z",
    ]);
  });

  it("drain() interleaves events from multiple tasks by timestamp", async () => {
    const spool = openEventSpool({ root: dir });
    await spool.enqueue(
      event({
        timestamp: "2026-05-15T12:00:00.000Z",
        task_id: "github:owner/repo#1",
      }),
    );
    await spool.enqueue(
      event({
        timestamp: "2026-05-15T12:00:01.000Z",
        task_id: "linear:eng#42",
      }),
    );
    await spool.enqueue(
      event({
        timestamp: "2026-05-15T12:00:02.000Z",
        task_id: "github:owner/repo#1",
      }),
    );

    const drained = await spool.drain();
    assert.deepEqual(
      drained.map((e) => e.event.task_id),
      ["github:owner/repo#1", "linear:eng#42", "github:owner/repo#1"],
    );
  });

  it("dequeue removes a spooled event", async () => {
    const spool = openEventSpool({ root: dir });
    const name = await spool.enqueue(event());
    assert.equal((await spool.drain()).length, 1);

    await spool.dequeue(name);
    assert.equal(existsSync(spool.pathFor(name)), false);
    assert.deepEqual(await spool.drain(), []);
  });

  it("dequeue is a no-op for missing files", async () => {
    const spool = openEventSpool({ root: dir });
    assert.equal(await spool.dequeue("nope.json"), undefined);
  });

  it("drain() ignores stray .tmp files (partial writes)", async () => {
    const spool = openEventSpool({ root: dir });
    await spool.enqueue(event());

    writeFileSync(
      join(dir, "events", "2026-05-15T12:00:00.000Z-x.json.tmp.99.0.abc"),
      "{partial",
    );

    assert.equal((await spool.drain()).length, 1);
  });

  it("drain() ignores malformed JSON", async () => {
    const spool = openEventSpool({ root: dir });
    writeFileSync(
      join(dir, "events", "2026-05-15T12:00:00.000Z-x.json"),
      "{not-json",
    );
    assert.deepEqual(await spool.drain(), []);
  });

  it("drain() ignores JSON that doesn't match the event shape", async () => {
    const spool = openEventSpool({ root: dir });
    writeFileSync(
      join(dir, "events", "2026-05-15T12:00:00.000Z-x.json"),
      JSON.stringify({ kind: "not-a-real-kind", task_id: "x" }),
    );
    assert.deepEqual(await spool.drain(), []);
  });

  it("drain() returns [] when events dir is missing", async () => {
    const empty = freshRoot();
    try {
      const spool = openEventSpool({ root: empty });
      assert.deepEqual(await spool.drain(), []);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("enqueue rejects non-conforming events", async () => {
    const spool = openEventSpool({ root: dir });
    await assert.rejects(
      spool.enqueue({
        kind: "bogus",
        task_id: "x",
        timestamp: "now",
        payload: {},
      } as unknown as DispatchEvent),
    );
  });

  it("enqueue rejects non-UTC timestamps", async () => {
    const spool = openEventSpool({ root: dir });
    await assert.rejects(
      spool.enqueue(event({ timestamp: "2026-05-15T12:00:00+02:00" })),
    );
  });

  it("survives a replay round-trip with extra forward-compat fields", async () => {
    const spool = openEventSpool({ root: dir });
    await spool.enqueue(
      event({
        payload: { number: 7 },
        future_field: { nested: true },
      } as unknown as Partial<DispatchEvent>),
    );
    const [first] = await spool.drain();
    assert.deepEqual(first?.event.payload, { number: 7 });
    assert.deepEqual((first?.event as Record<string, unknown>).future_field, {
      nested: true,
    });
  });

  it("write is atomic — no leftover tmp on success", async () => {
    const spool = openEventSpool({ root: dir });
    await spool.enqueue(event());
    const entries = readdirSync(join(dir, "events"));
    assert.deepEqual(
      entries.filter((n) => n.includes(".tmp.")),
      [],
    );
  });
});
