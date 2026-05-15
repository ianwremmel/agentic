import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { strict as assert } from "node:assert";

import { DispatchError, ExitCode } from "../cli/errors.mts";
import { DEFAULT_CONFIG } from "./schema.mts";
import { loadConfig, resolveConfigPath } from "./load.mts";
import { validate } from "./validate.mts";

describe("resolveConfigPath", () => {
  it("honours XDG_CONFIG_HOME when set", () => {
    const p = resolveConfigPath({ XDG_CONFIG_HOME: "/x/config", HOME: "/h" });
    assert.equal(p, "/x/config/dispatch/config.json");
  });

  it("falls back to $HOME/.config when XDG is unset", () => {
    const p = resolveConfigPath({ HOME: "/home/me" });
    assert.equal(p, "/home/me/.config/dispatch/config.json");
  });
});

describe("validate", () => {
  it("accepts an empty object as the defaults", () => {
    const r = validate({});
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.value.runner.binary, DEFAULT_CONFIG.runner.binary);
      assert.equal(r.value.daemon.heartbeatIntervalSeconds, 600);
      assert.equal(r.value.daemon.maxConcurrentRunners, 4);
    }
  });

  it("rejects unknown top-level keys", () => {
    const r = validate({ foo: 1 });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.errors.join("\n"), /unknown key "foo"/);
  });

  it("rejects non-object roots", () => {
    assert.equal(validate(null).ok, false);
    assert.equal(validate([]).ok, false);
    assert.equal(validate("oops").ok, false);
  });

  it("requires runner.binary when runner is present", () => {
    const r = validate({ runner: {} });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.errors.join("\n"), /runner\.binary: required/);
  });

  it("validates runner.session_id_capture enum", () => {
    const r = validate({
      runner: { binary: "x", session_id_capture: "magic" },
    });
    assert.equal(r.ok, false);
    if (!r.ok)
      assert.match(r.errors.join("\n"), /session_id_capture: must be one of/);
  });

  it("accepts a fully populated runner block", () => {
    const r = validate({
      runner: {
        binary: "claude",
        extra_args: ["--dangerously-skip-permissions"],
        resume_flag: "--resume",
        session_id_capture: "stderr-jsonline",
        permissions: "bypass",
      },
    });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.deepEqual(r.value.runner, {
        binary: "claude",
        extraArgs: ["--dangerously-skip-permissions"],
        resumeFlag: "--resume",
        sessionIdCapture: "stderr-jsonline",
        permissions: "bypass",
      });
    }
  });

  it("rejects negative daemon.heartbeat_interval_seconds", () => {
    const r = validate({ daemon: { heartbeat_interval_seconds: -1 } });
    assert.equal(r.ok, false);
  });

  it("rejects non-integer daemon.max_concurrent_runners", () => {
    const r = validate({ daemon: { max_concurrent_runners: 2.5 } });
    assert.equal(r.ok, false);
  });

  it("accepts a linear tracker with workspace_id", () => {
    const r = validate({
      tracker: {
        work: { kind: "linear", token: "lin_xxx", workspace_id: "ws1" },
      },
    });
    assert.equal(r.ok, true);
    if (r.ok)
      assert.deepEqual(r.value.trackers.work, {
        kind: "linear",
        token: "lin_xxx",
        workspaceId: "ws1",
      });
  });

  it("requires asana tracker workspace_id", () => {
    const r = validate({ tracker: { a: { kind: "asana", token: "x" } } });
    assert.equal(r.ok, false);
    if (!r.ok)
      assert.match(r.errors.join("\n"), /tracker\.a\.workspace_id: required/);
  });

  it("rejects unknown tracker kind", () => {
    const r = validate({ tracker: { x: { kind: "jira", token: "x" } } });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.errors.join("\n"), /tracker\.x\.kind/);
  });

  it("accepts buildkite and github-actions ci blocks", () => {
    const r = validate({
      ci: {
        bk: { kind: "buildkite", token: "bkua_x", organization: "acme" },
        gha: { kind: "github-actions" },
      },
    });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.deepEqual(r.value.ci.bk, {
        kind: "buildkite",
        token: "bkua_x",
        organization: "acme",
      });
      assert.deepEqual(r.value.ci.gha, { kind: "github-actions" });
    }
  });

  it("collects multiple errors at once", () => {
    const r = validate({
      runner: { binnary: "claude" }, // typo
      daemon: { max_concurrent_runners: 0 },
    });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.ok(r.errors.length > 1);
      assert.match(r.errors.join("\n"), /unknown key "binnary"/);
      assert.match(r.errors.join("\n"), /max_concurrent_runners/);
    }
  });
});

describe("loadConfig", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dispatch-cfg-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns defaults when no file exists", () => {
    const cfg = loadConfig({ path: join(dir, "missing.json") });
    assert.deepEqual(cfg, DEFAULT_CONFIG);
  });

  it("loads and validates a real file", () => {
    const p = join(dir, "config.json");
    writeFileSync(
      p,
      JSON.stringify({
        runner: { binary: "claude", extra_args: ["--xx"] },
        daemon: { max_concurrent_runners: 8 },
      }),
    );
    const cfg = loadConfig({ path: p });
    assert.equal(cfg.runner.binary, "claude");
    assert.deepEqual(cfg.runner.extraArgs, ["--xx"]);
    assert.equal(cfg.daemon.maxConcurrentRunners, 8);
  });

  it("throws USAGE on invalid JSON", () => {
    const p = join(dir, "broken.json");
    writeFileSync(p, "{not json");
    try {
      loadConfig({ path: p });
      throw new Error("should have thrown");
    } catch (e) {
      assert.ok(e instanceof DispatchError);
      const err = e as DispatchError;
      assert.equal(err.code, ExitCode.USAGE);
      assert.match(err.message, /invalid JSON/);
    }
  });

  it("throws USAGE with line-per-error on schema violations", () => {
    const p = join(dir, "bad.json");
    writeFileSync(
      p,
      JSON.stringify({
        runner: { binary: "" },
        daemon: { max_concurrent_runners: -1 },
      }),
    );
    try {
      loadConfig({ path: p });
      throw new Error("should have thrown");
    } catch (e) {
      const err = e as DispatchError;
      assert.equal(err.code, ExitCode.USAGE);
      assert.match(err.message, /invalid config at /);
      assert.match(err.message, /runner\.binary/);
      assert.match(err.message, /max_concurrent_runners/);
    }
  });

  it("surfaces non-ENOENT read errors", () => {
    // A directory at the config path produces EISDIR on read.
    const p = join(dir, "config.json");
    mkdirSync(p);
    assert.throws(() => loadConfig({ path: p }), DispatchError);
  });

  it("resolves the path from env when no override is given", () => {
    // Point HOME at a brand-new dir with no config file; expect defaults.
    const cfg = loadConfig({
      env: { HOME: dir, PATH: process.env.PATH ?? "" },
    });
    assert.deepEqual(cfg, DEFAULT_CONFIG);
  });
});
