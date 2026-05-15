import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { strict as assert } from "node:assert";

import { resolvePrompt } from "./resolve.mts";

function tmpRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `dispatch-prompts-${prefix}-`));
}

function writeFile(path: string, content: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

describe("resolvePrompt — layered lookup", () => {
  let cwd: string;
  let userCfg: string;

  beforeEach(() => {
    cwd = tmpRoot("cwd");
    userCfg = tmpRoot("usercfg");
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(userCfg, { recursive: true, force: true });
  });

  it("layer 1: repo .xml wins over everything", () => {
    writeFile(
      join(cwd, ".dispatch/prompts/heartbeat.xml"),
      "<repo-xml-heartbeat/>",
    );
    writeFile(
      join(cwd, ".dispatch/prompts/heartbeat.md"),
      "# repo md heartbeat",
    );
    writeFile(join(userCfg, "prompts/heartbeat.xml"), "<user-xml-heartbeat/>");

    const r = resolvePrompt("heartbeat", cwd, { userConfigDir: userCfg });
    assert.equal(r.source, "repo");
    assert.match(r.path, /\.dispatch\/prompts\/heartbeat\.xml$/);
    assert.equal(r.content, "<repo-xml-heartbeat/>");
  });

  it("layer 2: repo .md wins when repo .xml is absent", () => {
    writeFile(
      join(cwd, ".dispatch/prompts/heartbeat.md"),
      "# repo md heartbeat",
    );
    writeFile(join(userCfg, "prompts/heartbeat.xml"), "<user-xml-heartbeat/>");

    const r = resolvePrompt("heartbeat", cwd, { userConfigDir: userCfg });
    assert.equal(r.source, "repo");
    assert.match(r.path, /\.dispatch\/prompts\/heartbeat\.md$/);
    assert.equal(r.content, "# repo md heartbeat");
  });

  it("layer 3: user .xml wins when no repo layer exists", () => {
    writeFile(join(userCfg, "prompts/heartbeat.xml"), "<user-xml-heartbeat/>");
    writeFile(join(userCfg, "prompts/heartbeat.md"), "# user md heartbeat");

    const r = resolvePrompt("heartbeat", cwd, { userConfigDir: userCfg });
    assert.equal(r.source, "user");
    assert.match(r.path, /prompts\/heartbeat\.xml$/);
    assert.ok(!r.path.includes(".dispatch"));
    assert.equal(r.content, "<user-xml-heartbeat/>");
  });

  it("layer 4: user .md wins when user .xml is absent", () => {
    writeFile(join(userCfg, "prompts/heartbeat.md"), "# user md heartbeat");

    const r = resolvePrompt("heartbeat", cwd, { userConfigDir: userCfg });
    assert.equal(r.source, "user");
    assert.match(r.path, /prompts\/heartbeat\.md$/);
    assert.equal(r.content, "# user md heartbeat");
  });

  it("layer 5: built-in is returned when no override exists", () => {
    const r = resolvePrompt("heartbeat", cwd, { userConfigDir: userCfg });
    assert.equal(r.source, "built-in");
    assert.match(r.content, /<prompt event="heartbeat"/);
  });

  it("uses XDG_CONFIG_HOME-derived user-config dir when no override given", () => {
    // Don't supply userConfigDir; rely on env resolution.
    writeFile(join(userCfg, "dispatch/prompts/heartbeat.xml"), "<env-xml/>");
    const r = resolvePrompt("heartbeat", cwd, {
      env: { XDG_CONFIG_HOME: userCfg },
    });
    assert.equal(r.source, "user");
    assert.equal(r.content, "<env-xml/>");
  });

  it("falls back to $HOME/.config/dispatch when XDG is unset", () => {
    writeFile(
      join(userCfg, ".config/dispatch/prompts/heartbeat.xml"),
      "<home-xml/>",
    );
    const r = resolvePrompt("heartbeat", cwd, {
      env: { HOME: userCfg, XDG_CONFIG_HOME: undefined },
    });
    assert.equal(r.source, "user");
    assert.equal(r.content, "<home-xml/>");
  });

  it("throws for unknown event kinds", () => {
    assert.throws(
      () => resolvePrompt("not-a-real-event", cwd, { userConfigDir: userCfg }),
      /Unknown event kind/,
    );
  });

  it("each event kind round-trips through every layer fall-through", () => {
    // Smoke-test all 12 kinds for the most error-prone path (layer 5).
    const kinds = [
      "bootstrap",
      "pr-comment",
      "pr-review",
      "ci-finished",
      "pr-state-change",
      "ticket-comment",
      "ticket-state",
      "heartbeat",
      "daemon-restart",
      "runner-error",
      "pr-coalesced",
      "ticket-coalesced",
    ] as const;
    for (const k of kinds) {
      const r = resolvePrompt(k, cwd, { userConfigDir: userCfg });
      assert.equal(r.source, "built-in");
      assert.match(r.content, new RegExp(`<prompt event="${k}"`));
    }
  });

  it("propagates non-ENOENT read errors", () => {
    // Make `<cwd>/.dispatch/prompts/heartbeat.xml` a directory; reading it
    // raises EISDIR, which must surface rather than fall through.
    mkdirSync(join(cwd, ".dispatch/prompts/heartbeat.xml"), {
      recursive: true,
    });
    assert.throws(
      () => resolvePrompt("heartbeat", cwd, { userConfigDir: userCfg }),
      /EISDIR/,
    );
  });
});
