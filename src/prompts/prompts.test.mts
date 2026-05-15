import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import { EVENT_KINDS } from "../state/event.mts";
import { builtinPromptAssetMap, getBuiltinPrompt } from "./index.mts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");

describe("getBuiltinPrompt", () => {
  it("returns a built-in source tagged result for every event kind", () => {
    for (const kind of EVENT_KINDS) {
      const prompt = getBuiltinPrompt(kind);
      assert.equal(prompt.source, "built-in");
      assert.ok(prompt.path.length > 0);
      assert.ok(prompt.content.length > 0);
    }
  });

  it('emits XML matching <prompt event="<kind>"> for each kind', () => {
    for (const kind of EVENT_KINDS) {
      const prompt = getBuiltinPrompt(kind);
      assert.match(prompt.content, new RegExp(`<prompt event="${kind}"`));
    }
  });

  it("path points at the on-disk built-in template under dev/test", () => {
    const prompt = getBuiltinPrompt("heartbeat");
    // Outside SEA the loader reads from src/prompts/built-in/<event>.xml.
    assert.match(prompt.path, /src\/prompts\/built-in\/heartbeat\.xml$/);
    assert.equal(existsSync(prompt.path), true);
  });
});

describe("builtinPromptAssetMap", () => {
  it("maps every event kind to a checked-in template that exists", () => {
    const map = builtinPromptAssetMap();
    assert.deepEqual(
      Object.keys(map).sort(),
      EVENT_KINDS.map((k) => `prompts/built-in/${k}.xml`).sort(),
    );
    for (const [, relPath] of Object.entries(map)) {
      assert.equal(existsSync(resolve(repoRoot, relPath)), true);
    }
  });

  it("content of every mapped file is the same as readFileSync sees", () => {
    const map = builtinPromptAssetMap();
    for (const [key, relPath] of Object.entries(map)) {
      const onDisk = readFileSync(resolve(repoRoot, relPath), "utf8");
      assert.equal(
        key.startsWith("prompts/built-in/") && key.endsWith(".xml"),
        true,
      );
      assert.ok(onDisk.includes("<prompt event="));
    }
  });
});
