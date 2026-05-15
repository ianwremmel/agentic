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

import { ensureStateLayout } from "./paths.mts";
import { openTaskStore } from "./task-store.mts";
import type { TaskRecord } from "./task-record.mts";

function freshRoot(): string {
  return mkdtempSync(join(tmpdir(), "dispatch-tasks-"));
}

function baseRecord(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "github:owner/repo#123",
    worktree: "/tmp/wt-1",
    head: null,
    session_id: null,
    subscriptions: [],
    last_heartbeat: null,
    live_runner_pid: null,
    pending_followup: null,
    ...overrides,
  };
}

describe("TaskStore", () => {
  let dir: string;

  beforeEach(() => {
    dir = freshRoot();
    ensureStateLayout({ root: dir });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns null when no record exists", async () => {
    const store = openTaskStore({ root: dir });
    assert.equal(await store.read("github:owner/repo#1"), null);
  });

  it("creates, reads, updates, and deletes a record", async () => {
    const store = openTaskStore({ root: dir });
    const rec = baseRecord();

    await store.write(rec);
    assert.equal(existsSync(store.pathFor(rec.id)), true);

    const got = await store.read(rec.id);
    assert.deepEqual(got, rec);

    const updated = baseRecord({ head: "abc123", session_id: "sess-1" });
    await store.write(updated);
    assert.deepEqual(await store.read(rec.id), updated);

    await store.delete(rec.id);
    assert.equal(await store.read(rec.id), null);
  });

  it("delete is a no-op for missing files", async () => {
    const store = openTaskStore({ root: dir });
    const result = await store.delete("github:owner/repo#nope");
    assert.equal(result, undefined);
  });

  it("stores the canonical ID inside the JSON verbatim", async () => {
    const store = openTaskStore({ root: dir });
    const rec = baseRecord({ id: "github:owner/repo#123" });
    await store.write(rec);

    const onDisk = readdirSync(join(dir, "tasks"));
    assert.ok(onDisk.includes("github%3aowner%2frepo%23123.json"));

    const got = await store.read(rec.id);
    assert.equal(got?.id, "github:owner/repo#123");
  });

  it("preserves unknown extra fields across read+write", async () => {
    const store = openTaskStore({ root: dir });
    const rec = baseRecord({
      future_field: { nested: [1, 2, 3] },
      another_one: "yes",
    } as unknown as Partial<TaskRecord>);
    await store.write(rec);

    const got = await store.read(rec.id);
    assert.deepEqual(got, rec);
    assert.deepEqual((got as Record<string, unknown>).future_field, {
      nested: [1, 2, 3],
    });
    assert.equal((got as Record<string, unknown>).another_one, "yes");
  });

  it("list() returns every fully-written record", async () => {
    const store = openTaskStore({ root: dir });
    const a = baseRecord({ id: "github:o/r#1", worktree: "/w/a" });
    const b = baseRecord({ id: "linear:eng#42", worktree: "/w/b" });
    await store.write(a);
    await store.write(b);

    const all = await store.list();
    const ids = all.map((r) => r.id).sort();
    assert.deepEqual(ids, ["github:o/r#1", "linear:eng#42"]);
  });

  it("list() ignores stray .tmp partial-write files", async () => {
    const store = openTaskStore({ root: dir });
    const a = baseRecord({ id: "github:o/r#1" });
    await store.write(a);

    // Simulate a crashed write: leftover tmp file.
    writeFileSync(
      join(dir, "tasks", "github%3ao%2fr%232.json.tmp.999.0.abc"),
      "{partial",
    );

    const all = await store.list();
    assert.deepEqual(
      all.map((r) => r.id),
      ["github:o/r#1"],
    );
  });

  it("list() ignores non-decodable filenames", async () => {
    const store = openTaskStore({ root: dir });
    writeFileSync(join(dir, "tasks", "not%zz-encoded.json"), '{"x":1}');
    assert.deepEqual(await store.list(), []);
  });

  it("list() returns [] when the tasks dir is missing", async () => {
    const empty = freshRoot();
    try {
      const store = openTaskStore({ root: empty });
      assert.deepEqual(await store.list(), []);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("write is atomic — no temp file remains after success", async () => {
    const store = openTaskStore({ root: dir });
    await store.write(baseRecord());
    const entries = readdirSync(join(dir, "tasks"));
    const tmp = entries.filter((n) => n.includes(".tmp."));
    assert.deepEqual(tmp, []);
    assert.deepEqual(entries, ["github%3aowner%2frepo%23123.json"]);
  });

  it("rejects records with empty id", async () => {
    const store = openTaskStore({ root: dir });
    await assert.rejects(
      () => store.write(baseRecord({ id: "" })),
      /non-empty id/,
    );
  });

  it("throws on malformed JSON content", async () => {
    const store = openTaskStore({ root: dir });
    const rec = baseRecord();
    await store.write(rec);

    writeFileSync(store.pathFor(rec.id), "not-json");
    await assert.rejects(() => store.read(rec.id));
  });

  it("throws when JSON is valid but does not match TaskRecord shape", async () => {
    const store = openTaskStore({ root: dir });
    const rec = baseRecord();
    await store.write(rec);

    writeFileSync(store.pathFor(rec.id), JSON.stringify({ id: "x" }));
    await assert.rejects(() => store.read(rec.id), /malformed/);
  });
});
