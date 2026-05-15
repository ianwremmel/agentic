import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import { DispatchError, ExitCode } from "./errors.mts";
import { parseCommandArgs } from "./parser.mts";
import type { CommandSpec } from "./types.mts";

const noopHandler = () => {};

function spec(overrides: Partial<CommandSpec> = {}): CommandSpec {
  return {
    name: "test",
    summary: "",
    flags: [],
    positionals: [],
    handler: noopHandler,
    ...overrides,
  };
}

describe("parseCommandArgs", () => {
  it("parses boolean flags and applies defaults", () => {
    const cmd = spec({
      flags: [
        { name: "force", kind: "boolean", description: "" },
        { name: "verbose", kind: "boolean", description: "", default: true },
      ],
    });
    const { parsed } = parseCommandArgs(cmd, ["--force"]);
    assert.equal(parsed.flags.force, true);
    assert.equal(parsed.flags.verbose, true);
  });

  it("supports --no-flag negation", () => {
    const cmd = spec({
      flags: [
        { name: "verbose", kind: "boolean", description: "", default: true },
      ],
    });
    const { parsed } = parseCommandArgs(cmd, ["--no-verbose"]);
    assert.equal(parsed.flags.verbose, false);
  });

  it("accepts --flag=value and --flag value", () => {
    const cmd = spec({
      flags: [
        { name: "repo", kind: "string", description: "" },
        { name: "body", kind: "string", description: "" },
      ],
    });
    const { parsed } = parseCommandArgs(cmd, [
      "--repo=acme/foo",
      "--body",
      "hi",
    ]);
    assert.equal(parsed.flags.repo, "acme/foo");
    assert.equal(parsed.flags.body, "hi");
  });

  it("collects repeated string[] flags", () => {
    const cmd = spec({
      flags: [{ name: "reviewer", kind: "string[]", description: "" }],
    });
    const { parsed } = parseCommandArgs(cmd, [
      "--reviewer",
      "alice",
      "--reviewer",
      "bob",
    ]);
    assert.deepEqual(parsed.flags.reviewer, ["alice", "bob"]);
  });

  it("rejects values outside `choices`", () => {
    const cmd = spec({
      flags: [
        {
          name: "reaction",
          kind: "string",
          description: "",
          choices: ["+1", "-1"],
        },
      ],
    });
    assert.throws(
      () => parseCommandArgs(cmd, ["--reaction", "sparkle"]),
      DispatchError,
    );
    try {
      parseCommandArgs(cmd, ["--reaction", "sparkle"]);
    } catch (e) {
      const err = e as DispatchError;
      assert.equal(err.code, ExitCode.USAGE);
    }
  });

  it("enforces required flags", () => {
    const cmd = spec({
      flags: [
        { name: "repo", kind: "string", description: "", required: true },
      ],
    });
    assert.throws(() => parseCommandArgs(cmd, []), /missing required/);
  });

  it("enforces required positionals", () => {
    const cmd = spec({
      positionals: [{ name: "url-or-id", description: "", required: true }],
    });
    assert.throws(() => parseCommandArgs(cmd, []), /missing required/);
  });

  it("captures positionals in declared order", () => {
    const cmd = spec({
      positionals: [
        { name: "first", description: "", required: true },
        { name: "second", description: "" },
      ],
    });
    const { parsed } = parseCommandArgs(cmd, ["a", "b"]);
    assert.deepEqual(parsed.positionals, { first: "a", second: "b" });
  });

  it("collects extras into rest after --", () => {
    const cmd = spec({
      flags: [{ name: "foo", kind: "boolean", description: "" }],
    });
    const { parsed } = parseCommandArgs(cmd, ["--", "--foo", "bar"]);
    assert.deepEqual(parsed.rest, ["--foo", "bar"]);
    assert.equal(parsed.flags.foo, false);
  });

  it("rejects unknown flags", () => {
    assert.throws(() => parseCommandArgs(spec(), ["--nope"]), /unknown flag/);
  });

  it("invokes the per-command validate callback", () => {
    const cmd = spec({
      flags: [
        { name: "a", kind: "boolean", description: "" },
        { name: "b", kind: "boolean", description: "" },
      ],
      validate: (p) => (p.flags.a && p.flags.b ? "mutually exclusive" : null),
    });
    assert.throws(
      () => parseCommandArgs(cmd, ["--a", "--b"]),
      /mutually exclusive/,
    );
  });

  it("reports --help without enforcing required flags", () => {
    const cmd = spec({
      flags: [
        { name: "repo", kind: "string", description: "", required: true },
      ],
    });
    const { helpRequested } = parseCommandArgs(cmd, ["--help"]);
    assert.equal(helpRequested, true);
  });

  it("supports single-char aliases for boolean and string flags", () => {
    const cmd = spec({
      flags: [
        { name: "force", alias: "f", kind: "boolean", description: "" },
        { name: "body", alias: "b", kind: "string", description: "" },
      ],
    });
    const { parsed } = parseCommandArgs(cmd, ["-f", "-b", "hi"]);
    assert.equal(parsed.flags.force, true);
    assert.equal(parsed.flags.body, "hi");
  });
});
