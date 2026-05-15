import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import { resolveAsanaPat } from "./auth.mts";

describe("resolveAsanaPat", () => {
  it("returns explicit pat when provided", async () => {
    const v = await resolveAsanaPat({ pat: "explicit" });
    assert.equal(v, "explicit");
  });

  it("falls back to ASANA_PAT env", async () => {
    const v = await resolveAsanaPat({ env: { ASANA_PAT: "envkey" } });
    assert.equal(v, "envkey");
  });

  it("falls back to configLookup last", async () => {
    const v = await resolveAsanaPat({
      env: {},
      configLookup: async () => "config-pat",
    });
    assert.equal(v, "config-pat");
  });

  it("throws when nothing resolves", async () => {
    await assert.rejects(
      resolveAsanaPat({ env: {} }),
      /no Asana PAT available/,
    );
  });
});
