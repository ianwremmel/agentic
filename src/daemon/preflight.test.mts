import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildBaseProbes,
  formatFailures,
  verifyRequiredClis,
  type CliProbe,
  type ProbeRunner,
} from "./preflight.mts";

function runner(map: Record<string, { exitCode: number; reason?: string }>): ProbeRunner {
  return async (probe) => {
    const key = probe.argv.join(" ");
    const out = map[key];
    if (!out) return { exitCode: -1, reason: `no probe registered for "${key}"` };
    return out;
  };
}

describe("buildBaseProbes", () => {
  it("emits runner, git, gh present, and gh auth probes by default", () => {
    const ps = buildBaseProbes({ runnerBin: "claude" });
    const names = ps.map((p) => p.name);
    assert.deepEqual(names, ["claude", "git", "gh", "gh auth"]);
    const ghAuth = ps.find((p) => p.name === "gh auth")!;
    assert.equal(ghAuth.asserts, "authenticated");
    assert.deepEqual(ghAuth.argv, ["gh", "auth", "status"]);
  });

  it("appends CI and tracker probes when configured", () => {
    const ps = buildBaseProbes({ runnerBin: "claude", ciCli: "bk", trackerCli: "linear" });
    assert.deepEqual(
      ps.map((p) => p.name),
      ["claude", "git", "gh", "gh auth", "bk", "linear"],
    );
  });

  it("skips CI/tracker when null", () => {
    const ps = buildBaseProbes({ runnerBin: "claude", ciCli: null, trackerCli: null });
    assert.equal(ps.length, 4);
  });
});

describe("verifyRequiredClis", () => {
  it("returns ok when every probe exits 0", async () => {
    const probes = buildBaseProbes({ runnerBin: "claude" });
    const r = await verifyRequiredClis(
      probes,
      runner({
        "claude --version": { exitCode: 0 },
        "git --version": { exitCode: 0 },
        "gh --version": { exitCode: 0 },
        "gh auth status": { exitCode: 0 },
      }),
    );
    assert.deepEqual(r, { ok: true, failures: [] });
  });

  it("collects all failures, preserving probe order", async () => {
    const probes: CliProbe[] = [
      { name: "claude", argv: ["claude", "--version"], asserts: "present" },
      { name: "git", argv: ["git", "--version"], asserts: "present" },
      { name: "gh auth", argv: ["gh", "auth", "status"], asserts: "authenticated" },
    ];
    const r = await verifyRequiredClis(
      probes,
      runner({
        "claude --version": { exitCode: -1, reason: "command not found" },
        "git --version": { exitCode: 0 },
        "gh auth status": { exitCode: 1, reason: "not logged in" },
      }),
    );
    assert.equal(r.ok, false);
    assert.equal(r.failures.length, 2);
    assert.equal(r.failures[0].probe.name, "claude");
    assert.equal(r.failures[0].exitCode, -1);
    assert.match(r.failures[0].reason, /command not found/);
    assert.equal(r.failures[1].probe.name, "gh auth");
    assert.match(r.failures[1].reason, /not logged in/);
  });

  it("supplies a default reason based on assertion kind", async () => {
    const r = await verifyRequiredClis(
      [
        { name: "git", argv: ["git", "--version"], asserts: "present" },
        { name: "gh auth", argv: ["gh", "auth", "status"], asserts: "authenticated" },
      ],
      runner({
        "git --version": { exitCode: 1 },
        "gh auth status": { exitCode: 1 },
      }),
    );
    assert.match(r.failures[0].reason, /not installed|non-zero/);
    assert.match(r.failures[1].reason, /not authenticated/);
  });

  it("runs probes sequentially (deterministic order)", async () => {
    const order: string[] = [];
    const probes = buildBaseProbes({ runnerBin: "claude" });
    await verifyRequiredClis(probes, async (p) => {
      order.push(p.name);
      return { exitCode: 0 };
    });
    assert.deepEqual(order, ["claude", "git", "gh", "gh auth"]);
  });
});

describe("formatFailures", () => {
  it("renders one line per failure with name, asserts, code, reason", () => {
    const out = formatFailures([
      {
        probe: { name: "git", argv: ["git", "--version"], asserts: "present" },
        exitCode: 127,
        reason: "not found",
      },
      {
        probe: { name: "gh auth", argv: ["gh", "auth", "status"], asserts: "authenticated" },
        exitCode: 1,
        reason: "no token",
      },
    ]);
    assert.match(out, /git \(present\): exit 127: not found/);
    assert.match(out, /gh auth \(authenticated\): exit 1: no token/);
  });
});
