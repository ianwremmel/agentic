import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import { resolveGitHubToken } from "./auth.mts";

describe("resolveGitHubToken", () => {
  it("returns GITHUB_TOKEN when set", async () => {
    const token = await resolveGitHubToken({
      env: { GITHUB_TOKEN: "envtoken" },
      ghAuthToken: async () => "should-not-be-used",
    });
    assert.equal(token, "envtoken");
  });

  it("falls back to ghAuthToken when env is empty", async () => {
    const token = await resolveGitHubToken({
      env: {},
      ghAuthToken: async () => "ghtoken",
    });
    assert.equal(token, "ghtoken");
  });

  it("ignores empty GITHUB_TOKEN and falls through to gh", async () => {
    const token = await resolveGitHubToken({
      env: { GITHUB_TOKEN: "" },
      ghAuthToken: async () => "ghtoken",
    });
    assert.equal(token, "ghtoken");
  });

  it("throws a generic error (no token value leaked) when nothing resolves", async () => {
    await assert.rejects(
      resolveGitHubToken({ env: {}, ghAuthToken: async () => undefined }),
      /no GitHub token available/,
    );
  });
});
