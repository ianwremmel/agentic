import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { decodeTaskId, encodeTaskId } from "./encoding.mts";
import {
  ensureStateLayout,
  layoutForRoot,
  resolveStateRoot,
} from "./paths.mts";

describe("encodeTaskId / decodeTaskId", () => {
  it("passes safe characters through unchanged", () => {
    const id = "abcXYZ0123._-";
    assert.equal(encodeTaskId(id), id);
    assert.equal(decodeTaskId(id), id);
  });

  it("encodes typical github task IDs lowercase", () => {
    const enc = encodeTaskId("github:owner/repo#123");
    assert.equal(enc, "github%3aowner%2frepo%23123");
    assert.equal(decodeTaskId(enc), "github:owner/repo#123");
  });

  it("encodes spaces and plus", () => {
    assert.equal(encodeTaskId("a b+c"), "a%20b%2bc");
  });

  it("encodes UTF-8 bytes for non-ASCII input", () => {
    // `ñ` is U+00F1 → C3 B1.
    const enc = encodeTaskId("piña");
    assert.equal(enc, "pi%c3%b1a");
    assert.equal(decodeTaskId(enc), "piña");
  });

  it("round-trips a tracker URL with colons, slashes, hashes", () => {
    const id = "linear:eng/team#ENG-42";
    assert.equal(decodeTaskId(encodeTaskId(id)), id);
  });

  it("round-trips multi-byte UTF-8 (CJK)", () => {
    const id = "github:owner/repo#日本語-1";
    assert.equal(decodeTaskId(encodeTaskId(id)), id);
  });

  it("round-trips emoji (4-byte UTF-8 sequence)", () => {
    const id = "task:🚀-launch";
    const enc = encodeTaskId(id);
    assert.equal(decodeTaskId(enc), id);
  });

  it("decodes uppercase hex for forward compatibility", () => {
    assert.equal(decodeTaskId("github%3AOwner"), "github:Owner");
  });

  it("throws on truncated percent escape", () => {
    assert.throws(() => decodeTaskId("ab%2"), /truncated/);
  });

  it("throws on invalid percent escape", () => {
    assert.throws(() => decodeTaskId("ab%zz"), /invalid percent-escape/);
  });

  it("throws on raw non-ASCII in encoded input", () => {
    assert.throws(() => decodeTaskId("piña"), /non-ASCII/);
  });
});

describe("resolveStateRoot", () => {
  it("uses Library/Application Support on darwin", () => {
    const r = resolveStateRoot({
      platform: "darwin",
      env: { HOME: "/Users/me" },
    });
    assert.equal(r, "/Users/me/Library/Application Support/dispatch");
  });

  it("uses XDG_STATE_HOME when set on linux", () => {
    const r = resolveStateRoot({
      platform: "linux",
      env: { HOME: "/home/me", XDG_STATE_HOME: "/var/state" },
    });
    assert.equal(r, "/var/state/dispatch");
  });

  it("falls back to ~/.local/state on linux when XDG is unset", () => {
    const r = resolveStateRoot({
      platform: "linux",
      env: { HOME: "/home/me" },
    });
    assert.equal(r, "/home/me/.local/state/dispatch");
  });

  it("honours an explicit root override", () => {
    const r = resolveStateRoot({ root: "/custom/dispatch" });
    assert.equal(r, "/custom/dispatch");
  });

  it("ignores an empty XDG_STATE_HOME", () => {
    const r = resolveStateRoot({
      platform: "linux",
      env: { HOME: "/home/me", XDG_STATE_HOME: "" },
    });
    assert.equal(r, "/home/me/.local/state/dispatch");
  });
});

describe("layoutForRoot", () => {
  it("builds the expected file paths", () => {
    const l = layoutForRoot("/r");
    assert.equal(l.pidFile, "/r/daemon.pid");
    assert.equal(l.logFile, "/r/daemon.log");
    assert.equal(l.tasksDir, "/r/tasks");
    assert.equal(l.eventsDir, "/r/events");
  });

  it("encodes task IDs in taskFile()", () => {
    const l = layoutForRoot("/r");
    assert.equal(
      l.taskFile("github:o/r#1"),
      "/r/tasks/github%3ao%2fr%231.json",
    );
  });

  it("places the timestamp first in eventFile()", () => {
    const l = layoutForRoot("/r");
    assert.equal(
      l.eventFile("2026-05-15T12:00:00Z", "github:o/r#1"),
      "/r/events/2026-05-15T12:00:00Z-github%3ao%2fr%231.json",
    );
  });
});

describe("ensureStateLayout", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dispatch-state-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates tasks/ and events/ idempotently", () => {
    const root = join(dir, "dispatch");
    const l1 = ensureStateLayout({ root });
    assert.equal(existsSync(l1.tasksDir), true);
    assert.equal(existsSync(l1.eventsDir), true);
    assert.equal(statSync(l1.tasksDir).isDirectory(), true);
    // Second call must not throw.
    const l2 = ensureStateLayout({ root });
    assert.equal(l2.root, l1.root);
  });

  it("does not create daemon.pid or daemon.log preemptively", () => {
    const root = join(dir, "dispatch");
    const l = ensureStateLayout({ root });
    assert.equal(existsSync(l.pidFile), false);
    assert.equal(existsSync(l.logFile), false);
  });
});
