import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { DispatchEvent, EventKind } from "../state/event.mts";
import { coalesce, PR_SIDE_KINDS, TICKET_SIDE_KINDS, sideOf } from "./coalesce.mts";

function ev(kind: EventKind, ts: string, payload: Record<string, unknown> = {}): DispatchEvent {
  return { kind, task_id: "github:o/r#1", timestamp: ts, payload };
}

describe("sideOf", () => {
  it("classifies PR-side kinds", () => {
    for (const k of PR_SIDE_KINDS) assert.equal(sideOf(k), "pr");
  });
  it("classifies ticket-side kinds", () => {
    for (const k of TICKET_SIDE_KINDS) assert.equal(sideOf(k), "ticket");
  });
  it("classifies others as 'other'", () => {
    assert.equal(sideOf("heartbeat"), "other");
    assert.equal(sideOf("daemon-restart"), "other");
    assert.equal(sideOf("runner-error"), "other");
    assert.equal(sideOf("pr-coalesced"), "other");
    assert.equal(sideOf("ticket-coalesced"), "other");
    assert.equal(sideOf("bootstrap"), "other");
  });
});

describe("coalesce", () => {
  it("returns a single base event unchanged", () => {
    const e = ev("pr-comment", "2026-05-15T10:00:00.000Z");
    const out = coalesce([e]);
    assert.deepEqual(out, [e]);
  });

  it("two PR-side events → pr-coalesced", () => {
    const a = ev("pr-comment", "2026-05-15T10:00:00.000Z", { who: "alice" });
    const b = ev("ci-finished", "2026-05-15T10:00:01.000Z", { status: "passed" });
    const out = coalesce([a, b]);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.kind, "pr-coalesced");
    assert.equal(out[0]!.timestamp, "2026-05-15T10:00:01.000Z");
    const originals = (out[0]!.payload as { originals: DispatchEvent[] }).originals;
    assert.equal(originals.length, 2);
    assert.deepEqual(originals[0], a);
    assert.deepEqual(originals[1], b);
  });

  it("two ticket-side events → ticket-coalesced", () => {
    const a = ev("ticket-comment", "2026-05-15T10:00:00.000Z");
    const b = ev("ticket-state", "2026-05-15T10:00:02.000Z", { from: "todo", to: "in-review" });
    const out = coalesce([a, b]);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.kind, "ticket-coalesced");
    assert.equal(out[0]!.timestamp, "2026-05-15T10:00:02.000Z");
    const originals = (out[0]!.payload as { originals: DispatchEvent[] }).originals;
    assert.equal(originals.length, 2);
  });

  it("mixed PR + ticket → pr-coalesced (spec rule)", () => {
    const a = ev("pr-review", "2026-05-15T10:00:00.000Z");
    const b = ev("ticket-state", "2026-05-15T10:00:01.000Z");
    const out = coalesce([a, b]);
    assert.equal(out[0]!.kind, "pr-coalesced");
    const originals = (out[0]!.payload as { originals: DispatchEvent[] }).originals;
    assert.equal(originals.length, 2);
  });

  it("passes through non-base kinds without coalescing them", () => {
    const hb = ev("heartbeat", "2026-05-15T10:00:00.000Z");
    const a = ev("pr-comment", "2026-05-15T10:00:01.000Z");
    const b = ev("pr-review", "2026-05-15T10:00:02.000Z");
    const out = coalesce([hb, a, b]);
    assert.equal(out.length, 2);
    assert.equal(out[0]!.kind, "heartbeat");
    assert.equal(out[1]!.kind, "pr-coalesced");
  });

  it("preserves originals verbatim (no lossy summarization)", () => {
    const a = ev("pr-comment", "2026-05-15T10:00:00.000Z", {
      author: "alice",
      body: "LGTM with one nit",
      thread_id: 7,
    });
    const b = ev("pr-review", "2026-05-15T10:00:01.000Z", {
      reviewer: "bob",
      state: "CHANGES_REQUESTED",
      comments: [{ path: "x.ts", line: 42 }],
    });
    const out = coalesce([a, b]);
    const originals = (out[0]!.payload as { originals: DispatchEvent[] }).originals;
    assert.deepEqual(originals[0], a);
    assert.deepEqual(originals[1], b);
  });

  it("rejects empty batches", () => {
    assert.throws(() => coalesce([]), RangeError);
  });

  it("rejects mixed task_id batches", () => {
    const a = ev("pr-comment", "2026-05-15T10:00:00.000Z");
    const b: DispatchEvent = {
      kind: "pr-comment",
      task_id: "github:other#2",
      timestamp: "2026-05-15T10:00:01.000Z",
      payload: {},
    };
    assert.throws(() => coalesce([a, b]), RangeError);
  });

  it("uses the newest timestamp on the synthesized event", () => {
    const a = ev("pr-comment", "2026-05-15T10:00:05.000Z");
    const b = ev("pr-review", "2026-05-15T10:00:01.000Z");
    const c = ev("pr-state-change", "2026-05-15T10:00:03.000Z");
    const out = coalesce([a, b, c]);
    assert.equal(out[0]!.timestamp, "2026-05-15T10:00:05.000Z");
  });
});
