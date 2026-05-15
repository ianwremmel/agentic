import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { ExitCode } from "./errors.mts";
import { run } from "./run.mts";

function streams() {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  stdout.on("data", (c: Buffer) => outChunks.push(c.toString("utf8")));
  stderr.on("data", (c: Buffer) => errChunks.push(c.toString("utf8")));
  return {
    stdout,
    stderr,
    out: () => outChunks.join(""),
    err: () => errChunks.join(""),
  };
}

const V = "0.0.0-test";

describe("run()", () => {
  it("prints top-level help on no args (exit 0)", async () => {
    const s = streams();
    const code = await run({
      argv: [],
      stdout: s.stdout,
      stderr: s.stderr,
      version: V,
    });
    assert.equal(code, ExitCode.SUCCESS);
    assert.ok(s.out().includes("Usage: dispatch <command>"));
    assert.equal(s.err(), "");
  });

  it("prints version on --version", async () => {
    const s = streams();
    const code = await run({
      argv: ["--version"],
      stdout: s.stdout,
      stderr: s.stderr,
      version: V,
    });
    assert.equal(code, ExitCode.SUCCESS);
    assert.equal(s.out(), `dispatch ${V}\n`);
  });

  it("returns USAGE (2) on unknown command", async () => {
    const s = streams();
    const code = await run({
      argv: ["nope"],
      stdout: s.stdout,
      stderr: s.stderr,
      version: V,
    });
    assert.equal(code, ExitCode.USAGE);
    assert.match(s.err(), /^dispatch: unknown command/);
  });

  it("renders command help for `daemon status --help`", async () => {
    const s = streams();
    const code = await run({
      argv: ["daemon", "status", "--help"],
      stdout: s.stdout,
      stderr: s.stderr,
      version: V,
    });
    assert.equal(code, ExitCode.SUCCESS);
    assert.ok(s.out().includes("Usage: dispatch daemon status"));
  });

  it("returns USAGE (2) when create-comment is missing --repo", async () => {
    const s = streams();
    const code = await run({
      argv: ["create-comment", "--pr", "1", "--body", "hi", "--agent-id", "x"],
      stdout: s.stdout,
      stderr: s.stderr,
      version: V,
    });
    assert.equal(code, ExitCode.USAGE);
    assert.match(s.err(), /dispatch: create-comment: missing required/);
  });

  it("returns USAGE (2) when create-comment passes both --pr and --issue", async () => {
    const s = streams();
    const code = await run({
      argv: [
        "create-comment",
        "--repo",
        "a/b",
        "--pr",
        "1",
        "--issue",
        "2",
        "--body",
        "hi",
        "--agent-id",
        "x",
      ],
      stdout: s.stdout,
      stderr: s.stderr,
      version: V,
    });
    assert.equal(code, ExitCode.USAGE);
    assert.match(s.err(), /mutually exclusive/);
  });

  it("returns USAGE (2) when react gets an invalid --reaction", async () => {
    const s = streams();
    const code = await run({
      argv: [
        "react",
        "--repo",
        "a/b",
        "--comment-id",
        "c1",
        "--reaction",
        "sparkle",
      ],
      stdout: s.stdout,
      stderr: s.stderr,
      version: V,
    });
    assert.equal(code, ExitCode.USAGE);
    assert.match(s.err(), /must be one of/);
  });

  it("invokes the stub handler and returns GENERIC (1) with a formatted error", async () => {
    const s = streams();
    const code = await run({
      argv: ["tasks", "list"],
      stdout: s.stdout,
      stderr: s.stderr,
      version: V,
    });
    assert.equal(code, ExitCode.GENERIC);
    assert.match(s.err(), /^dispatch: tasks list: /);
  });

  it("enforces prompts copy --repo XOR --home (USAGE 2)", async () => {
    const s1 = streams();
    assert.equal(
      await run({
        argv: ["prompts", "copy", "review"],
        stdout: s1.stdout,
        stderr: s1.stderr,
        version: V,
      }),
      ExitCode.USAGE,
    );
    assert.match(s1.err(), /exactly one of/);

    const s2 = streams();
    assert.equal(
      await run({
        argv: ["prompts", "copy", "--repo", "--home", "review"],
        stdout: s2.stdout,
        stderr: s2.stderr,
        version: V,
      }),
      ExitCode.USAGE,
    );
    assert.match(s2.err(), /mutually exclusive/);
  });

  it("supports repeated --reviewer for request-review", async () => {
    const s = streams();
    const code = await run({
      argv: [
        "request-review",
        "--repo",
        "a/b",
        "--pr",
        "1",
        "--reviewer",
        "alice",
        "--reviewer",
        "bob",
      ],
      stdout: s.stdout,
      stderr: s.stderr,
      version: V,
    });
    // Stub handler throws GENERIC; the important assertion is that the
    // argv parsed cleanly (no USAGE error).
    assert.equal(code, ExitCode.GENERIC);
    assert.match(s.err(), /^dispatch: request-review: /);
  });
});
