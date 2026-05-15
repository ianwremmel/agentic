import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  collectPromptsList,
  formatTSV,
  formatTable,
} from "./prompts-list.mts";
import { EVENT_KINDS } from "../state/event.mts";

function freshDirs(): { cwd: string; user: string } {
  const cwd = mkdtempSync(join(tmpdir(), "dispatch-pl-cwd-"));
  const user = mkdtempSync(join(tmpdir(), "dispatch-pl-user-"));
  return { cwd, user };
}

function envWith(user: string): NodeJS.ProcessEnv {
  return { HOME: "/dev/null", XDG_CONFIG_HOME: user };
}

describe("collectPromptsList", () => {
  it("returns one row per event kind with built-in source by default", () => {
    const { cwd, user } = freshDirs();
    const rows = collectPromptsList(cwd, envWith(user));
    assert.equal(rows.length, EVENT_KINDS.length);
    for (const r of rows) {
      assert.equal(r.source, "built-in");
      assert.ok(r.path.length > 0);
    }
    assert.deepEqual(
      rows.map((r) => r.event),
      [...EVENT_KINDS],
    );
  });

  it("reports a repo override when present", () => {
    const { cwd, user } = freshDirs();
    const dir = join(cwd, ".dispatch", "prompts");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "bootstrap.xml");
    writeFileSync(file, "<override/>");

    const rows = collectPromptsList(cwd, envWith(user));
    const row = rows.find((r) => r.event === "bootstrap");
    assert.ok(row);
    assert.equal(row.source, "repo");
    assert.equal(row.path, file);
  });

  it("reports a user override when no repo override exists", () => {
    const { cwd, user } = freshDirs();
    const dir = join(user, "dispatch", "prompts");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "heartbeat.md");
    writeFileSync(file, "user override");

    const rows = collectPromptsList(cwd, envWith(user));
    const row = rows.find((r) => r.event === "heartbeat");
    assert.ok(row);
    assert.equal(row.source, "user");
    assert.equal(row.path, file);
  });

  it("prefers repo over user when both exist", () => {
    const { cwd, user } = freshDirs();
    const repoDir = join(cwd, ".dispatch", "prompts");
    const userDir = join(user, "dispatch", "prompts");
    mkdirSync(repoDir, { recursive: true });
    mkdirSync(userDir, { recursive: true });
    writeFileSync(join(repoDir, "pr-comment.xml"), "repo");
    writeFileSync(join(userDir, "pr-comment.xml"), "user");

    const rows = collectPromptsList(cwd, envWith(user));
    const row = rows.find((r) => r.event === "pr-comment");
    assert.ok(row);
    assert.equal(row.source, "repo");
  });
});

describe("formatTSV", () => {
  it("emits tab-separated columns and no trailing newline", () => {
    const out = formatTSV([
      { event: "bootstrap", source: "built-in", path: "/a/b.xml" },
      { event: "heartbeat", source: "repo", path: "/c/d.xml" },
    ]);
    assert.equal(out, "bootstrap\tbuilt-in\t/a/b.xml\nheartbeat\trepo\t/c/d.xml");
  });

  it("returns empty string for no rows", () => {
    assert.equal(formatTSV([]), "");
  });
});

describe("formatTable", () => {
  it("aligns columns by padding the event and source fields", () => {
    const out = formatTable([
      { event: "bootstrap", source: "built-in", path: "/x.xml" },
      { event: "pr-comment", source: "repo", path: "/y.xml" },
    ]);
    const lines = out.split("\n");
    assert.equal(lines.length, 3);
    assert.equal(lines[0], "EVENT       SOURCE    PATH");
    assert.match(lines[1] ?? "", /^bootstrap {3}built-in {2}\/x\.xml$/);
    assert.match(lines[2] ?? "", /^pr-comment {2}repo {6}\/y\.xml$/);
  });
});
