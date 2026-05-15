import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  runPromptsCopy,
  resolveDestination,
  type PromptsCopyDeps,
} from "./prompts-copy.mts";
import { DispatchError, ExitCode } from "./errors.mts";

function freshDirs(): { cwd: string; user: string } {
  const cwd = mkdtempSync(join(tmpdir(), "dispatch-pc-cwd-"));
  const user = mkdtempSync(join(tmpdir(), "dispatch-pc-user-"));
  return { cwd, user };
}

function realDeps(cwd: string, user: string, builtin = "<built-in/>"): PromptsCopyDeps {
  return {
    cwd: () => cwd,
    env: { HOME: "/dev/null", XDG_CONFIG_HOME: user },
    readBuiltin: () => builtin,
    exists: existsSync,
    mkdirp: (p) => {
      mkdirSync(p, { recursive: true });
    },
    writeFile: (p, c) => {
      writeFileSync(p, c, "utf8");
    },
  };
}

describe("resolveDestination", () => {
  it("repo target points at <cwd>/.dispatch/prompts/<event>.xml", () => {
    const dest = resolveDestination("bootstrap", "repo", "/work/repo", {});
    assert.equal(dest, "/work/repo/.dispatch/prompts/bootstrap.xml");
  });

  it("home target honours XDG_CONFIG_HOME when set", () => {
    const dest = resolveDestination("heartbeat", "home", "/work/repo", {
      XDG_CONFIG_HOME: "/x/cfg",
    });
    assert.equal(dest, "/x/cfg/dispatch/prompts/heartbeat.xml");
  });

  it("home target falls back to $HOME/.config/dispatch when XDG is unset", () => {
    const dest = resolveDestination("pr-comment", "home", "/work/repo", {
      HOME: "/h/me",
    });
    assert.equal(dest, "/h/me/.config/dispatch/prompts/pr-comment.xml");
  });
});

describe("runPromptsCopy", () => {
  it("writes the built-in content to the repo destination", () => {
    const { cwd, user } = freshDirs();
    const deps = realDeps(cwd, user, "<repo/>");
    const result = runPromptsCopy(deps, {
      event: "bootstrap",
      target: "repo",
      force: false,
    });
    assert.equal(result.destination, join(cwd, ".dispatch", "prompts", "bootstrap.xml"));
    assert.equal(readFileSync(result.destination, "utf8"), "<repo/>");
    assert.equal(result.bytesWritten, Buffer.byteLength("<repo/>", "utf8"));
  });

  it("writes to the user-config dir for --home", () => {
    const { cwd, user } = freshDirs();
    const deps = realDeps(cwd, user, "<home/>");
    const result = runPromptsCopy(deps, {
      event: "heartbeat",
      target: "home",
      force: false,
    });
    assert.equal(result.destination, join(user, "dispatch", "prompts", "heartbeat.xml"));
    assert.equal(readFileSync(result.destination, "utf8"), "<home/>");
  });

  it("creates missing parent directories", () => {
    const { cwd, user } = freshDirs();
    const deps = realDeps(cwd, user);
    const result = runPromptsCopy(deps, {
      event: "pr-comment",
      target: "repo",
      force: false,
    });
    assert.ok(existsSync(result.destination));
  });

  it("rejects unknown event kinds with NOT_FOUND (3)", () => {
    const { cwd, user } = freshDirs();
    const deps = realDeps(cwd, user);
    try {
      runPromptsCopy(deps, { event: "not-a-real-event", target: "repo", force: false });
      assert.fail("should have thrown");
    } catch (err) {
      assert.ok(err instanceof DispatchError);
      assert.equal(err.code, ExitCode.NOT_FOUND);
      assert.match(err.message, /unknown event kind/);
    }
  });

  it("refuses to overwrite an existing target without --force (GENERIC 1)", () => {
    const { cwd, user } = freshDirs();
    const dest = join(cwd, ".dispatch", "prompts", "bootstrap.xml");
    mkdirSync(join(cwd, ".dispatch", "prompts"), { recursive: true });
    writeFileSync(dest, "<existing/>");

    const deps = realDeps(cwd, user, "<new/>");
    try {
      runPromptsCopy(deps, { event: "bootstrap", target: "repo", force: false });
      assert.fail("should have thrown");
    } catch (err) {
      assert.ok(err instanceof DispatchError);
      assert.equal(err.code, ExitCode.GENERIC);
      assert.match(err.message, /already exists/);
    }
    assert.equal(readFileSync(dest, "utf8"), "<existing/>", "file untouched");
  });

  it("overwrites an existing target when --force is passed", () => {
    const { cwd, user } = freshDirs();
    const dest = join(cwd, ".dispatch", "prompts", "bootstrap.xml");
    mkdirSync(join(cwd, ".dispatch", "prompts"), { recursive: true });
    writeFileSync(dest, "<existing/>");

    const deps = realDeps(cwd, user, "<replaced/>");
    const result = runPromptsCopy(deps, {
      event: "bootstrap",
      target: "repo",
      force: true,
    });
    assert.equal(result.destination, dest);
    assert.equal(readFileSync(dest, "utf8"), "<replaced/>");
  });

  it("wraps write failures as DispatchError(GENERIC)", () => {
    const { cwd, user } = freshDirs();
    const deps: PromptsCopyDeps = {
      ...realDeps(cwd, user),
      writeFile: () => {
        throw new Error("disk full");
      },
    };
    try {
      runPromptsCopy(deps, { event: "bootstrap", target: "repo", force: false });
      assert.fail("should have thrown");
    } catch (err) {
      assert.ok(err instanceof DispatchError);
      assert.equal(err.code, ExitCode.GENERIC);
      assert.match(err.message, /failed to write/);
      assert.match(err.message, /disk full/);
    }
  });
});
