import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import { AsanaError } from "./errors.mts";
import { AsanaHttpClient, type FetchInit, type FetchLike } from "./http.mts";

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
  const client = new AsanaHttpClient({
    pat: async () => "tok",
    fetch: ff.fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    now: () => 1_700_000_000_000,
    maxRetries: overrides.maxRetries ?? 3,
    baseBackoffMs: 5,
  });
  return { client, calls: ff.calls, sleeps };
}

describe("AsanaHttpClient.request", () => {
  it("returns unwrapped data on success", async () => {
    const { client, calls } = mkClient([
      { status: 200, body: { data: { gid: "1" } } },
    ]);
    const out = await client.request<{ gid: string }>("tasks/1");
    assert.equal(out.gid, "1");
    assert.equal(
      (calls[0]?.init.headers as Record<string, string>).authorization,
      "Bearer tok",
    );
  });

  it("wraps POST body in { data: ... }", async () => {
    const { client, calls } = mkClient([
      { status: 200, body: { data: { gid: "9" } } },
    ]);
    await client.request("tasks/1/stories", {
      method: "POST",
      body: { text: "hi" },
    });
    const sent = JSON.parse(calls[0]!.init.body as string) as {
      data: { text: string };
    };
    assert.equal(sent.data.text, "hi");
  });

  it("includes query parameters", async () => {
    const { client, calls } = mkClient([{ status: 200, body: { data: {} } }]);
    await client.request("tasks/1", { query: { opt_fields: "gid,name" } });
    assert.ok(calls[0]!.url.includes("opt_fields=gid%2Cname"));
  });

  it("retries on 5xx then succeeds", async () => {
    const { client, calls } = mkClient([
      { status: 500 },
      { status: 200, body: { data: { ok: 1 } } },
    ]);
    await client.request("x");
    assert.equal(calls.length, 2);
  });

  it("retries on 429 honoring Retry-After", async () => {
    const { client, sleeps } = mkClient([
      { status: 429, headers: { "retry-after": "3" } },
      { status: 200, body: { data: { ok: 1 } } },
    ]);
    await client.request("x");
    assert.equal(sleeps[0], 3000);
  });

  it("does not retry on 4xx", async () => {
    const { client, calls } = mkClient([{ status: 400, body: { msg: "bad" } }]);
    await assert.rejects(client.request("x"), (err) => {
      assert.equal((err as AsanaError).kind, "client-4xx");
      return true;
    });
    assert.equal(calls.length, 1);
  });

  it("classifies 401 as auth", async () => {
    const { client } = mkClient([{ status: 401 }]);
    await assert.rejects(client.request("x"), (err) => {
      assert.equal((err as AsanaError).kind, "auth");
      return true;
    });
  });

  it("classifies 404 as not-found", async () => {
    const { client } = mkClient([{ status: 404 }]);
    await assert.rejects(client.request("x"), (err) => {
      assert.equal((err as AsanaError).kind, "not-found");
      return true;
    });
  });

  it("retries on network errors", async () => {
    const { client, calls } = mkClient([
      new Error("ECONNRESET"),
      { status: 200, body: { data: {} } },
    ]);
    await client.request("x");
    assert.equal(calls.length, 2);
  });
});
