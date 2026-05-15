import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import { LinearAdapter } from "./client.mts";
import { LinearError } from "./errors.mts";
import type { FetchInit, FetchLike } from "./http.mts";

interface FakeResponse {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

function mkResponse(r: FakeResponse): Response {
  const headers = new Headers(r.headers ?? {});
  if (!headers.has("content-type"))
    headers.set("content-type", "application/json");
  const body =
    typeof r.body === "string" ? r.body : JSON.stringify(r.body ?? {});
  return new Response(body, { status: r.status, headers });
}

interface CallRecord {
  url: string;
  init: FetchInit;
  parsedBody:
    | { query: string; variables?: Record<string, unknown> }
    | undefined;
}

function fakeFetch(responses: FakeResponse[]): {
  fetch: FetchLike;
  calls: CallRecord[];
} {
  const calls: CallRecord[] = [];
  let i = 0;
  return {
    calls,
    async fetch(input, init) {
      const rawBody = typeof init.body === "string" ? init.body : null;
      calls.push({
        url: input,
        init,
        parsedBody:
          rawBody === null
            ? undefined
            : (JSON.parse(rawBody) as CallRecord["parsedBody"]),
      });
      const next = responses[i++];
      if (next === undefined) throw new Error("fakeFetch exhausted");
      return mkResponse(next);
    },
  };
}

function mkAdapter(responses: FakeResponse[]) {
  const ff = fakeFetch(responses);
  const adapter = new LinearAdapter({
    apiKey: "test-key",
    fetch: ff.fetch,
    sleep: async () => {},
    maxRetries: 0,
  });
  return { adapter, calls: ff.calls };
}

const RAW_TICKET = {
  id: "uuid-1",
  identifier: "DEV-42",
  url: "https://linear.app/acme/issue/DEV-42/slug",
  title: "Refactor adapter",
  description: "body",
  assignee: { id: "u1", name: "Ian", email: "ian@example.com" },
  labels: { nodes: [{ id: "l1", name: "core" }] },
  project: {
    id: "proj-1",
    name: "Dispatch",
    url: "https://linear.app/acme/project/dispatch-aaaaaaaa",
  },
  team: { id: "team-1", key: "DEV", name: "Dev" },
  state: { id: "st-1", name: "In Progress", type: "started" },
  parent: null,
  relations: { nodes: [] },
};

describe("LinearAdapter.resolveTicket", () => {
  it("returns canonical id + identifier for a TEAM-N", async () => {
    const { adapter, calls } = mkAdapter([
      {
        status: 200,
        body: { data: { issue: { id: "uuid-1", identifier: "DEV-42" } } },
      },
    ]);
    const ref = await adapter.resolveTicket("DEV-42");
    assert.deepEqual(ref, { id: "uuid-1", identifier: "DEV-42" });
    assert.equal(calls[0]?.parsedBody?.variables?.id, "DEV-42");
  });

  it("extracts the identifier from a Linear URL and upper-cases it", async () => {
    const { adapter, calls } = mkAdapter([
      {
        status: 200,
        body: { data: { issue: { id: "uuid-1", identifier: "DEV-42" } } },
      },
    ]);
    await adapter.resolveTicket(
      "https://linear.app/acme/issue/dev-42/refactor-things",
    );
    assert.equal(calls[0]?.parsedBody?.variables?.id, "DEV-42");
  });

  it("throws not-found when issue resolves to null", async () => {
    const { adapter } = mkAdapter([
      { status: 200, body: { data: { issue: null } } },
    ]);
    await assert.rejects(adapter.resolveTicket("DEV-99"), (err) => {
      assert.ok(err instanceof LinearError);
      assert.equal((err as LinearError).kind, "not-found");
      return true;
    });
  });

  it("throws for unrecognized references", async () => {
    const { adapter } = mkAdapter([]);
    await assert.rejects(adapter.resolveTicket("not-a-ticket"));
  });
});

describe("LinearAdapter.getTicket", () => {
  it("materializes the role from the default mapping", async () => {
    const { adapter } = mkAdapter([
      { status: 200, body: { data: { issue: RAW_TICKET } } },
    ]);
    const t = await adapter.getTicket("uuid-1");
    assert.equal(t.identifier, "DEV-42");
    assert.deepEqual(t.role, { group: "started", role: "in-progress" });
    assert.equal(t.assignee?.name, "Ian");
    assert.equal(t.labels[0]?.name, "core");
  });

  it("leaves role null when no mapping applies", async () => {
    const raw = {
      ...RAW_TICKET,
      state: { id: "x", name: "Mystery", type: "started" },
    };
    const { adapter } = mkAdapter([
      { status: 200, body: { data: { issue: raw } } },
    ]);
    const t = await adapter.getTicket("uuid-1");
    assert.equal(t.role, null);
  });
});

describe("LinearAdapter HTTP behavior", () => {
  it("sends the API key in the Authorization header (no Bearer prefix)", async () => {
    const { adapter, calls } = mkAdapter([
      {
        status: 200,
        body: { data: { issue: { id: "x", identifier: "DEV-1" } } },
      },
    ]);
    await adapter.resolveTicket("DEV-1");
    const auth = (calls[0]?.init.headers as Record<string, string>)
      .authorization;
    assert.equal(auth, "test-key");
  });

  it("classifies GraphQL errors with extensions.type=AuthenticationError as auth", async () => {
    const { adapter } = mkAdapter([
      {
        status: 200,
        body: {
          errors: [
            {
              message: "you cannot do that",
              extensions: { type: "AuthenticationError" },
            },
          ],
        },
      },
    ]);
    await assert.rejects(adapter.resolveTicket("DEV-1"), (err) => {
      assert.equal((err as LinearError).kind, "auth");
      return true;
    });
  });

  it("classifies HTTP 401 as auth", async () => {
    const { adapter } = mkAdapter([{ status: 401, body: { message: "nope" } }]);
    await assert.rejects(adapter.resolveTicket("DEV-1"), (err) => {
      assert.equal((err as LinearError).kind, "auth");
      return true;
    });
  });
});
