import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import { GitHubError, isGitHubError } from "./errors.mts";
import { GitHubHttpClient, type FetchInit } from "./http.mts";

interface FakeResponse {
  status: number;
  body?: string;
  headers?: Record<string, string>;
}

type FakeInit = NonNullable<ConstructorParameters<typeof Response>[1]>;

function mkResponse(r: FakeResponse): Response {
  const init: FakeInit = {
    status: r.status,
    headers: r.headers,
  };
  // 204/205/304 must have a null body per fetch spec.
  const nullBody = r.status === 204 || r.status === 205 || r.status === 304;
  return new Response(nullBody ? null : (r.body ?? ""), init);
}

function fakeFetch(responses: Array<FakeResponse | Error>): {
  fetch: (input: string, init: FetchInit) => Promise<Response>;
  calls: Array<{ url: string; init: FetchInit }>;
} {
  const calls: Array<{ url: string; init: FetchInit }> = [];
  let i = 0;
  return {
    calls,
    async fetch(input, init) {
      calls.push({ url: input, init });
      const next = responses[i++];
      if (next instanceof Error) throw next;
      if (next === undefined) throw new Error("fakeFetch exhausted responses");
      return mkResponse(next);
    },
  };
}

function mkClient(
  responses: Array<FakeResponse | Error>,
  overrides: { maxRetries?: number; baseBackoffMs?: number } = {},
) {
  const sleeps: number[] = [];
  const ff = fakeFetch(responses);
  const client = new GitHubHttpClient({
    token: async () => "test-token",
    fetch: ff.fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    now: () => 1_000_000,
    maxRetries: overrides.maxRetries ?? 3,
    baseBackoffMs: overrides.baseBackoffMs ?? 10,
    maxBackoffMs: 10_000,
  });
  return { client, sleeps, calls: ff.calls };
}

describe("GitHubHttpClient.rest", () => {
  it("returns parsed JSON on 200", async () => {
    const { client } = mkClient([
      { status: 200, body: JSON.stringify({ login: "octocat" }) },
    ]);
    const data = await client.rest<{ login: string }>("GET", "/user");
    assert.equal(data.login, "octocat");
  });

  it("injects auth, accept, user-agent, and api-version headers", async () => {
    const { client, calls } = mkClient([
      { status: 200, body: JSON.stringify({}) },
    ]);
    await client.rest("GET", "/user");
    const h = calls[0]?.init.headers as Record<string, string>;
    assert.equal(h.authorization, "Bearer test-token");
    assert.equal(h.accept, "application/vnd.github+json");
    assert.equal(h["x-github-api-version"], "2022-11-28");
    assert.ok(h["user-agent"]);
  });

  it("retries on 500 then succeeds", async () => {
    const { client, sleeps } = mkClient([
      { status: 500, body: "boom" },
      { status: 200, body: JSON.stringify({ ok: true }) },
    ]);
    const data = await client.rest<{ ok: boolean }>("GET", "/x");
    assert.equal(data.ok, true);
    assert.equal(sleeps.length, 1);
  });

  it("honors Retry-After on 429", async () => {
    const { client, sleeps } = mkClient([
      {
        status: 429,
        body: "rate",
        headers: { "retry-after": "2" },
      },
      { status: 200, body: JSON.stringify({}) },
    ]);
    await client.rest("GET", "/x");
    assert.equal(sleeps[0], 2_000);
  });

  it("uses exponential backoff when no Retry-After is provided", async () => {
    const { client, sleeps } = mkClient(
      [
        { status: 500, body: "" },
        { status: 500, body: "" },
        { status: 500, body: "" },
        { status: 200, body: JSON.stringify({}) },
      ],
      { baseBackoffMs: 10 },
    );
    await client.rest("GET", "/x");
    assert.deepEqual(sleeps, [10, 20, 40]);
  });

  it("gives up after maxRetries and throws server-5xx", async () => {
    const { client } = mkClient(
      Array.from({ length: 5 }, () => ({ status: 500, body: "boom" })),
      { maxRetries: 2 },
    );
    await assert.rejects(client.rest("GET", "/x"), (err: unknown) => {
      assert.ok(isGitHubError(err));
      const e = err as GitHubError;
      assert.equal(e.kind, "server-5xx");
      assert.equal(e.status, 500);
      return true;
    });
  });

  it("does NOT retry on 404", async () => {
    const { client, sleeps } = mkClient([{ status: 404, body: "" }]);
    await assert.rejects(client.rest("GET", "/x"), (err: unknown) => {
      assert.ok(isGitHubError(err));
      assert.equal((err as GitHubError).kind, "not-found");
      return true;
    });
    assert.equal(sleeps.length, 0);
  });

  it("does NOT retry on 401", async () => {
    const { client, sleeps } = mkClient([{ status: 401, body: "" }]);
    await assert.rejects(client.rest("GET", "/x"), (err: unknown) => {
      assert.equal((err as GitHubError).kind, "auth");
      return true;
    });
    assert.equal(sleeps.length, 0);
  });

  it("retries on network errors", async () => {
    const { client, sleeps } = mkClient([
      new Error("ECONNRESET"),
      { status: 200, body: JSON.stringify({}) },
    ]);
    await client.rest("GET", "/x");
    assert.equal(sleeps.length, 1);
  });

  it("returns undefined for 204 No Content", async () => {
    const { client } = mkClient([{ status: 204 }]);
    const data = await client.rest<undefined>("DELETE", "/x");
    assert.equal(data, undefined);
  });

  it("sends a JSON body when one is provided", async () => {
    const { client, calls } = mkClient([
      { status: 201, body: JSON.stringify({ id: 7 }) },
    ]);
    await client.rest("POST", "/x", { body: { hello: "world" } });
    assert.equal(calls[0]?.init.method, "POST");
    assert.equal(
      (calls[0]?.init.headers as Record<string, string>)["content-type"],
      "application/json",
    );
    assert.equal(calls[0]?.init.body, '{"hello":"world"}');
  });

  it("redacts access_token in error URLs", async () => {
    const { client } = mkClient(
      Array.from({ length: 8 }, () => ({ status: 500, body: "" })),
      { maxRetries: 0 },
    );
    await assert.rejects(
      client.rest("GET", "https://api.github.com/x?access_token=SECRET"),
      (err: unknown) => {
        const msg = (err as Error).message;
        assert.ok(!msg.includes("SECRET"), `leaked: ${msg}`);
        assert.ok(msg.includes("REDACTED"));
        return true;
      },
    );
  });
});

describe("GitHubHttpClient.graphql", () => {
  it("returns data on success", async () => {
    const { client } = mkClient([
      {
        status: 200,
        body: JSON.stringify({ data: { viewer: { login: "x" } } }),
      },
    ]);
    const data = await client.graphql<{ viewer: { login: string } }>(
      `query { viewer { login } }`,
    );
    assert.equal(data.viewer.login, "x");
  });

  it("throws not-found when errors contain NOT_FOUND", async () => {
    const { client } = mkClient([
      {
        status: 200,
        body: JSON.stringify({
          errors: [{ message: "Could not find", type: "NOT_FOUND" }],
        }),
      },
    ]);
    await assert.rejects(client.graphql("query { x }"), (err: unknown) => {
      assert.equal((err as GitHubError).kind, "not-found");
      return true;
    });
  });
});
