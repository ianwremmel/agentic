import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import { AsanaAdapter } from "./client.mts";
import { MappingError } from "./state-mapping.mts";
import type { FetchInit, FetchLike } from "./http.mts";

interface FakeResponse {
  status: number;
  body?: unknown;
}

function mkResponse(r: FakeResponse): Response {
  const headers = new Headers({ "content-type": "application/json" });
  return new Response(JSON.stringify(r.body ?? {}), {
    status: r.status,
    headers,
  });
}

interface Call {
  url: string;
  init: FetchInit;
}

function fakeFetch(responses: FakeResponse[]): {
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
      return mkResponse(next);
    },
  };
}

function mkAdapter(responses: FakeResponse[]) {
  const ff = fakeFetch(responses);
  const adapter = new AsanaAdapter({
    pat: "test-pat",
    fetch: ff.fetch,
    sleep: async () => {},
    maxRetries: 0,
  });
  return { adapter, calls: ff.calls };
}

const RAW_TASK = {
  gid: "12345",
  name: "Refactor adapter",
  notes: "body",
  completed: false,
  permalink_url: "https://app.asana.com/0/100/12345",
  assignee: { gid: "u1", name: "Ian", email: "ian@example.com" },
  tags: [{ gid: "t1", name: "core" }],
  projects: [
    {
      gid: "100",
      name: "Dispatch",
      permalink_url: "https://app.asana.com/0/100",
    },
  ],
  parent: null,
  dependencies: [],
  custom_fields: [
    {
      gid: "cf1",
      name: "Status",
      resource_subtype: "enum",
      enum_value: { gid: "opt1", name: "In Progress" },
    },
  ],
};

describe("AsanaAdapter.resolveTicket", () => {
  it("accepts a numeric gid", async () => {
    const { adapter, calls } = mkAdapter([
      { status: 200, body: { data: { gid: "12345" } } },
    ]);
    const ref = await adapter.resolveTicket("12345");
    assert.deepEqual(ref, { id: "12345", identifier: "12345" });
    assert.ok(calls[0]!.url.includes("tasks/12345"));
  });

  it("extracts gid from a /0/<proj>/<task> URL", async () => {
    const { adapter, calls } = mkAdapter([
      { status: 200, body: { data: { gid: "12345" } } },
    ]);
    await adapter.resolveTicket("https://app.asana.com/0/100/12345");
    assert.ok(calls[0]!.url.includes("tasks/12345"));
  });

  it("rejects unrecognized references", async () => {
    const { adapter } = mkAdapter([]);
    await assert.rejects(adapter.resolveTicket("not-a-task"));
  });
});

describe("AsanaAdapter.getTicket", () => {
  it("materializes the role from the default mapping", async () => {
    const { adapter } = mkAdapter([{ status: 200, body: { data: RAW_TASK } }]);
    const t = await adapter.getTicket("12345");
    assert.equal(t.identifier, "12345");
    assert.deepEqual(t.role, { group: "started", role: "in-progress" });
    assert.equal(t.assignee?.name, "Ian");
    assert.equal(t.labels[0]?.name, "core");
    assert.equal(t.project?.id, "100");
  });

  it("returns role null when the status option doesn't match", async () => {
    const raw = {
      ...RAW_TASK,
      custom_fields: [
        {
          gid: "cf1",
          name: "Status",
          resource_subtype: "enum",
          enum_value: { gid: "opt1", name: "Mystery" },
        },
      ],
    };
    const { adapter } = mkAdapter([{ status: 200, body: { data: raw } }]);
    const t = await adapter.getTicket("12345");
    assert.equal(t.role, null);
  });

  it("returns role verified when the task is completed", async () => {
    const raw = { ...RAW_TASK, completed: true };
    const { adapter } = mkAdapter([{ status: 200, body: { data: raw } }]);
    const t = await adapter.getTicket("12345");
    assert.deepEqual(t.role, { group: "completed", role: "verified" });
  });
});

describe("AsanaAdapter.transitionTicket", () => {
  it("sets completed=true when targeting verified", async () => {
    const { adapter, calls } = mkAdapter([
      { status: 200, body: { data: { gid: "12345", completed: true } } },
    ]);
    await adapter.transitionTicket("12345", "verified");
    const sent = JSON.parse(calls[0]!.init.body as string) as {
      data: { completed: boolean };
    };
    assert.equal(sent.data.completed, true);
  });

  it("sets custom_fields when targeting other roles", async () => {
    const { adapter, calls } = mkAdapter([
      { status: 200, body: { data: { gid: "12345" } } },
    ]);
    await adapter.transitionTicket("12345", "in-review", {
      statusFieldGid: "cf1",
      statusOptionGid: "opt-in-review",
    });
    const sent = JSON.parse(calls[0]!.init.body as string) as {
      data: { custom_fields: Record<string, string>; completed: boolean };
    };
    assert.equal(sent.data.completed, false);
    assert.equal(sent.data.custom_fields.cf1, "opt-in-review");
  });

  it("throws MappingError when gids are missing for non-verified target", async () => {
    const { adapter } = mkAdapter([]);
    await assert.rejects(
      adapter.transitionTicket("12345", "in-progress"),
      MappingError,
    );
  });
});

describe("AsanaAdapter.createComment + addReaction", () => {
  it("posts to /tasks/:id/stories", async () => {
    const { adapter, calls } = mkAdapter([
      { status: 200, body: { data: { gid: "story-1" } } },
    ]);
    const r = await adapter.createComment("12345", "hi");
    assert.equal(r.id, "story-1");
    assert.ok(calls[0]!.url.includes("tasks/12345/stories"));
    assert.equal(calls[0]!.init.method, "POST");
  });

  it("likes the story on +1 reaction", async () => {
    const { adapter, calls } = mkAdapter([
      { status: 200, body: { data: { gid: "story-1", liked: true } } },
    ]);
    await adapter.addReaction("story-1", "+1");
    const sent = JSON.parse(calls[0]!.init.body as string) as {
      data: { liked: boolean };
    };
    assert.equal(sent.data.liked, true);
  });

  it("rejects unsupported reaction types", async () => {
    const { adapter } = mkAdapter([]);
    await assert.rejects(adapter.addReaction("story-1", "rocket"));
  });
});
