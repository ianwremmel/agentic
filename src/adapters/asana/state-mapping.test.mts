import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import { mapAsanaState, MappingError } from "./state-mapping.mts";

describe("mapAsanaState defaults", () => {
  it("Complete → completed/verified", () => {
    assert.deepEqual(mapAsanaState({ state: { completed: true } }), {
      group: "completed",
      role: "verified",
    });
  });

  it("Incomplete / Backlogged → backlog/backlog", () => {
    assert.deepEqual(
      mapAsanaState({
        state: { completed: false, statusOption: "Backlogged" },
      }),
      { group: "backlog", role: "backlog" },
    );
  });

  it("Incomplete / Paused → backlog/paused", () => {
    assert.deepEqual(
      mapAsanaState({ state: { completed: false, statusOption: "Paused" } }),
      { group: "backlog", role: "paused" },
    );
  });

  it("Incomplete / Blocked → backlog/awaiting-external", () => {
    assert.deepEqual(
      mapAsanaState({ state: { completed: false, statusOption: "Blocked" } }),
      { group: "backlog", role: "awaiting-external" },
    );
  });

  it("Incomplete / Committed → unstarted/available", () => {
    assert.deepEqual(
      mapAsanaState({ state: { completed: false, statusOption: "Committed" } }),
      { group: "unstarted", role: "available" },
    );
  });

  it("Incomplete / In Progress → started/in-progress", () => {
    assert.deepEqual(
      mapAsanaState({
        state: { completed: false, statusOption: "In Progress" },
      }),
      { group: "started", role: "in-progress" },
    );
  });

  it("Incomplete / In Review → started/in-review", () => {
    assert.deepEqual(
      mapAsanaState({
        state: { completed: false, statusOption: "in review" },
      }),
      { group: "started", role: "in-review" },
    );
  });

  it("case-insensitive matching", () => {
    assert.deepEqual(
      mapAsanaState({
        state: { completed: false, statusOption: "BACKLOGGED" },
      }),
      { group: "backlog", role: "backlog" },
    );
  });
});

describe("mapAsanaState overrides", () => {
  it("project override wins over workspace and default", () => {
    const role = mapAsanaState(
      {
        state: { completed: false, statusOption: "In Progress" },
        projectId: "p1",
      },
      {
        projectOverrides: {
          p1: [{ statusOption: "In Progress", role: "delivered" }],
        },
        workspaceOverrides: [{ statusOption: "In Progress", role: "finished" }],
      },
    );
    assert.deepEqual(role, { group: "started", role: "delivered" });
  });

  it("workspace override wins over default when project doesn't match", () => {
    const role = mapAsanaState(
      { state: { completed: false, statusOption: "In Progress" } },
      {
        workspaceOverrides: [{ statusOption: "In Progress", role: "finished" }],
      },
    );
    assert.deepEqual(role, { group: "started", role: "finished" });
  });

  it("override role with no group infers from role family", () => {
    const role = mapAsanaState(
      { state: { completed: false, statusOption: "Custom" } },
      { workspaceOverrides: [{ statusOption: "Custom", role: "canceled" }] },
    );
    assert.deepEqual(role, { group: "canceled", role: "canceled" });
  });

  it("completedOverride replaces the default verified mapping", () => {
    const role = mapAsanaState(
      { state: { completed: true } },
      { completedOverride: { role: "delivered", group: "started" } },
    );
    assert.deepEqual(role, { group: "started", role: "delivered" });
  });
});

describe("mapAsanaState errors", () => {
  it("throws MappingError for incomplete with no status", () => {
    assert.throws(
      () => mapAsanaState({ state: { completed: false } }),
      MappingError,
    );
  });

  it("throws MappingError for unknown status option", () => {
    assert.throws(
      () =>
        mapAsanaState({
          state: { completed: false, statusOption: "Mysterious" },
        }),
      MappingError,
    );
  });
});
