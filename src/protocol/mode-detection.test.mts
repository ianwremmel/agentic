import { describe, it, beforeEach } from "node:test";
import { strict as assert } from "node:assert";

import {
  clearModeCache,
  detectMode,
  type CredentialFingerprint,
  type ViewerIdentity,
  type ViewerLookup,
} from "./mode-detection.mts";
import type { Mode } from "./wire-format.mts";

function fixed(identity: ViewerIdentity | null): ViewerLookup {
  return async () => identity;
}

function counting(identity: ViewerIdentity | null): {
  lookup: ViewerLookup;
  calls: () => number;
} {
  let calls = 0;
  return {
    lookup: async () => {
      calls += 1;
      return identity;
    },
    calls: () => calls,
  };
}

const fpString: CredentialFingerprint = (c) => String(c);

describe("detectMode — typed identity", () => {
  let cache: Map<string, Mode>;
  beforeEach(() => {
    cache = new Map();
  });

  it("returns A when the platform marks the account as a bot", async () => {
    const mode = await detectMode(
      "github",
      "tok",
      fixed({ typedBot: true, names: ["someone"] }),
      fpString,
      { cache },
    );
    assert.equal(mode, "A");
  });

  it("returns B for a regular human account", async () => {
    const mode = await detectMode(
      "github",
      "tok",
      fixed({ typedBot: false, names: ["ianwremmel"] }),
      fpString,
      { cache },
    );
    assert.equal(mode, "B");
  });
});

describe("detectMode — name matching (§Mode A signals)", () => {
  let cache: Map<string, Mode>;
  beforeEach(() => {
    cache = new Map();
  });

  const cases: Array<[string, Mode]> = [
    ["copilot-helper", "A"],
    ["Copilot", "A"],
    ["github-copilot", "A"],
    ["openai-codex", "A"],
    ["MyCodex42", "A"],
    ["claude-bot", "A"],
    ["CLAUDE", "A"],
    ["ai-agent", "A"],
    ["x-ai-agent-y", "A"],
    ["ianwremmel", "B"],
    ["alice", "B"],
    ["copilotinside", "A"],
    ["robot-overlord", "B"],
  ];

  for (const [name, expected] of cases) {
    it(`${JSON.stringify(name)} → ${expected}`, async () => {
      const mode = await detectMode(
        "github",
        "tok",
        fixed({ typedBot: false, names: [name] }),
        fpString,
        { cache },
      );
      assert.equal(mode, expected);
    });
  }

  it("matches across multiple surfaces (login + display name + email)", async () => {
    const mode = await detectMode(
      "linear",
      "tok",
      fixed({ names: ["Real Human", "rh@example.com", "rh-claude"] }),
      fpString,
      { cache },
    );
    assert.equal(mode, "A");
  });

  it("is case-insensitive", async () => {
    const mode = await detectMode(
      "github",
      "tok",
      fixed({ names: ["CoPiLoT"] }),
      fpString,
      { cache },
    );
    assert.equal(mode, "A");
  });
});

describe("detectMode — default to B on uncertainty (§Default)", () => {
  let cache: Map<string, Mode>;
  beforeEach(() => {
    cache = new Map();
  });

  it("returns B when the lookup throws", async () => {
    const lookup: ViewerLookup = async () => {
      throw new Error("network");
    };
    const mode = await detectMode("github", "tok", lookup, fpString, { cache });
    assert.equal(mode, "B");
  });

  it("returns B when the lookup returns null", async () => {
    const mode = await detectMode("github", "tok", fixed(null), fpString, {
      cache,
    });
    assert.equal(mode, "B");
  });

  it("returns B when the identity has neither typedBot nor matching name", async () => {
    const mode = await detectMode("github", "tok", fixed({}), fpString, {
      cache,
    });
    assert.equal(mode, "B");
  });
});

describe("detectMode — caching", () => {
  let cache: Map<string, Mode>;
  beforeEach(() => {
    cache = new Map();
  });

  it("hits the lookup only once per (platform, credentials) pair", async () => {
    const c = counting({ typedBot: true });
    await detectMode("github", "tok-1", c.lookup, fpString, { cache });
    await detectMode("github", "tok-1", c.lookup, fpString, { cache });
    await detectMode("github", "tok-1", c.lookup, fpString, { cache });
    assert.equal(c.calls(), 1);
  });

  it("does not share decisions across platforms", async () => {
    const c = counting({ typedBot: true });
    await detectMode("github", "tok", c.lookup, fpString, { cache });
    await detectMode("linear", "tok", c.lookup, fpString, { cache });
    assert.equal(c.calls(), 2);
  });

  it("does not share decisions across credentials", async () => {
    const c = counting({ typedBot: true });
    await detectMode("github", "tok-a", c.lookup, fpString, { cache });
    await detectMode("github", "tok-b", c.lookup, fpString, { cache });
    assert.equal(c.calls(), 2);
  });

  it("does not cache when the fingerprint returns null", async () => {
    const c = counting({ typedBot: true });
    const noFp: CredentialFingerprint = () => null;
    await detectMode("github", "tok", c.lookup, noFp, { cache });
    await detectMode("github", "tok", c.lookup, noFp, { cache });
    assert.equal(c.calls(), 2);
  });

  it("clearModeCache wipes per-process state", async () => {
    const c = counting({ typedBot: true });
    await detectMode("github", "tok", c.lookup, fpString, { cache });
    clearModeCache({ cache });
    await detectMode("github", "tok", c.lookup, fpString, { cache });
    assert.equal(c.calls(), 2);
  });
});

describe("detectMode — custom glob list", () => {
  it("supports overriding the default pattern set", async () => {
    const mode = await detectMode(
      "asana",
      "tok",
      fixed({ names: ["jenkins"] }),
      fpString,
      { nameMatchGlobs: ["*jenkins*"], cache: new Map() },
    );
    assert.equal(mode, "A");
  });
});
