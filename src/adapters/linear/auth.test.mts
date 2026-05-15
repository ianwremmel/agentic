import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import { resolveLinearApiKey } from "./auth.mts";

describe("resolveLinearApiKey", () => {
  it("returns the explicit apiKey when provided", async () => {
    const v = await resolveLinearApiKey({ apiKey: "explicit" });
    assert.equal(v, "explicit");
  });

  it("falls back to LINEAR_API_KEY env", async () => {
    const v = await resolveLinearApiKey({
      env: { LINEAR_API_KEY: "envkey" },
    });
    assert.equal(v, "envkey");
  });

  it("falls back to configLookup last", async () => {
    const v = await resolveLinearApiKey({
      env: {},
      configLookup: async () => "configkey",
    });
    assert.equal(v, "configkey");
  });

  it("throws when nothing resolves", async () => {
    await assert.rejects(
      resolveLinearApiKey({ env: {} }),
      /no Linear API key available/,
    );
  });
});
