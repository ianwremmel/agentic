import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import { LinearError } from "./errors.mts";
import { LinearHttpClient, type FetchInit, type FetchLike } from "./http.mts";

type FakeInit = NonNullable<ConstructorParameters<typeof Response>[1]>;

interface FakeResponse {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

function mkResp(r: FakeResponse): Response {
  const headers = new Headers(r.headers ?? {});
  if (!headers.has("content-type"))
    headers.set("content-type", "application/json");
  const init: FakeInit = { status: r.status, headers };
  const isEmpty = r.status === 204 || r.status === 205 || r.status === 304;
  const body = isEmpty
    ? null
    : typeof r.body === "string"
      ? r.body
      : JSON.stringify(r.body ?? {});
  return new Response(body, init);
}

interface Call {
  url: string;
  init: FetchInit;
}

function fakeFetch(responses: Array<FakeResponse | Error>): {
  fetch: FetchLike;
  calls: Call[];
} {
  const calls: Call[] = [];
  let i = 0;
  return {
    calls,
    async fetch(input, init) {
      calls.push({ url: input, init });
      const next = responses[i++];
      if (next === undefined) throw new Error("fakeFetch exhausted");
      if (next instanceof Error) throw next;
      return mkResp(next);
    },
  };
}

function mkClient(
  responses: Array<FakeResponse | Error>,
  overrides: { maxRetries?: number } = {},
) {
  const ff = fakeFetch(responses);
  const sleeps: number[] = [];
  const client = new LinearHttpClient({
    apiKey: async () => "secret-key",
    fetch: ff.fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    now: () => 1_700_000_000_000,
    maxRetries: overrides.maxRetries ?? 3,
    baseBackoffMs: 10,
  });
  return { client, calls: ff.calls, sleeps };
}

describe("LinearHttpClient.graphql", () => {
  it("returns data on a successful response", async () => {
    const { client, calls } = mkClient([
      { status: 200, body: { data: { viewer: { id: "u1" } } } },
    ]);
    const data = await client.graphql<{ viewer: { id: string } }>(
      "{ viewer { id } }",
    );
    assert.equal(data.viewer.id, "u1");
    assert.equal(calls.length, 1);
    assert.equal(
      (calls[0]?.init.headers as Record<string, string>).authorization,
      "secret-key",
    );
  });

  it("sends variables and operationName when provided", async () => {
    const { client, calls } = mkClient([
      { status: 200, body: { data: { ok: true } } },
    ]);
    await client.graphql("query Q($x:Int!){ ok }", {
      variables: { x: 1 },
      operationName: "Q",
    });
    const body = JSON.parse(calls[0]!.init.body as string) as {
      operationName: string;
      variables: { x: number };
    };
    assert.equal(body.operationName, "Q");
    assert.equal(body.variables.x, 1);
  });

  it("retries on 5xx then succeeds", async () => {
    const { client, calls, sleeps } = mkClient([
      { status: 500 },
      { status: 502 },
      { status: 200, body: { data: { ok: 1 } } },
    ]);
    await client.graphql("{ ok }");
    assert.equal(calls.length, 3);
    assert.equal(sleeps.length, 2);
  });

  it("retries on 429 honoring Retry-After seconds", async () => {
    const { client, sleeps } = mkClient([
      { status: 429, headers: { "retry-after": "2" } },
      { status: 200, body: { data: { ok: 1 } } },
    ]);
    await client.graphql("{ ok }");
    assert.equal(sleeps[0], 2000);
  });

  it("retries on network errors", async () => {
    const { client, calls } = mkClient([
      new Error("ECONNRESET"),
      { status: 200, body: { data: { ok: 1 } } },
    ]);
    await client.graphql("{ ok }");
    assert.equal(calls.length, 2);
  });

  it("does NOT retry on 4xx", async () => {
    const { client, calls } = mkClient([
      { status: 400, body: { error: "bad" } },
    ]);
    await assert.rejects(client.graphql("{ ok }"), (err) => {
      assert.ok(err instanceof LinearError);
      assert.equal((err as LinearError).kind, "client-4xx");
      return true;
    });
    assert.equal(calls.length, 1);
  });

  it("classifies 401 as auth", async () => {
    const { client } = mkClient([{ status: 401 }]);
    await assert.rejects(client.graphql("{ ok }"), (err) => {
      assert.equal((err as LinearError).kind, "auth");
      return true;
    });
  });

  it("classifies GraphQL AuthenticationError as auth", async () => {
    const { client } = mkClient([
      {
        status: 200,
        body: {
          errors: [
            { message: "nope", extensions: { type: "AuthenticationError" } },
          ],
        },
      },
    ]);
    await assert.rejects(client.graphql("{ ok }"), (err) => {
      assert.equal((err as LinearError).kind, "auth");
      return true;
    });
  });

  it("throws after exhausting retries on persistent 5xx", async () => {
    const { client, calls } = mkClient(
      [{ status: 500 }, { status: 500 }, { status: 500 }, { status: 500 }],
      { maxRetries: 3 },
    );
    await assert.rejects(client.graphql("{ ok }"), (err) => {
      assert.equal((err as LinearError).kind, "server-5xx");
      return true;
    });
    assert.equal(calls.length, 4);
  });
});
