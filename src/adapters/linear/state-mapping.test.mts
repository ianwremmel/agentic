import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import {
  mapLinearState,
  MappingError,
  type LinearWorkflowState,
  type MappingOptions,
  type OverrideEntry,
} from "./state-mapping.mts";

function state(
  name: string,
  type: LinearWorkflowState["type"] = "backlog",
): LinearWorkflowState {
  return { id: `s-${name}`, name, type };
}

describe("mapLinearState — defaults", () => {
  it("maps Backlog → backlog/backlog", () => {
    assert.deepEqual(mapLinearState({ state: state("Backlog", "backlog") }), {
      group: "backlog",
      role: "backlog",
    });
  });
  it("maps TODO → unstarted/available", () => {
    assert.deepEqual(mapLinearState({ state: state("Todo", "unstarted") }), {
      group: "unstarted",
      role: "available",
    });
  });
  it("maps In Progress → started/in-progress", () => {
    assert.deepEqual(
      mapLinearState({ state: state("In Progress", "started") }),
      { group: "started", role: "in-progress" },
    );
  });
  it("maps In Review → started/in-review", () => {
    assert.deepEqual(mapLinearState({ state: state("In Review", "started") }), {
      group: "started",
      role: "in-review",
    });
  });
  it("maps Finished → started/finished", () => {
    assert.deepEqual(mapLinearState({ state: state("Finished", "started") }), {
      group: "started",
      role: "finished",
    });
  });
  it("maps Delivered → started/delivered", () => {
    assert.deepEqual(mapLinearState({ state: state("Delivered", "started") }), {
      group: "started",
      role: "delivered",
    });
  });
  it("maps Done → completed/verified", () => {
    assert.deepEqual(mapLinearState({ state: state("Done", "completed") }), {
      group: "completed",
      role: "verified",
    });
  });
  it("maps Canceled → canceled/canceled (and Cancelled spelling too)", () => {
    assert.deepEqual(mapLinearState({ state: state("Canceled", "canceled") }), {
      group: "canceled",
      role: "canceled",
    });
    assert.deepEqual(
      mapLinearState({ state: state("Cancelled", "canceled") }),
      { group: "canceled", role: "canceled" },
    );
  });
  it("ignores case in substate name", () => {
    assert.deepEqual(
      mapLinearState({ state: state("in progress", "started") }),
      { group: "started", role: "in-progress" },
    );
  });
});

describe("mapLinearState — overrides", () => {
  const opts = (): MappingOptions => ({
    workspaceOverrides: [
      { substate: "Awaiting QA", role: "awaiting-external", group: "backlog" },
    ],
    teamOverrides: {
      DEV: [{ substate: "Paused", role: "paused", group: "backlog" }],
    },
  });

  it("team override beats workspace override", () => {
    const merged: MappingOptions = {
      workspaceOverrides: [
        {
          substate: "Paused",
          role: "awaiting-external",
          group: "backlog",
        },
      ],
      teamOverrides: {
        DEV: [{ substate: "Paused", role: "paused", group: "backlog" }],
      },
    };
    assert.deepEqual(
      mapLinearState(
        { state: state("Paused", "backlog"), teamKey: "DEV" },
        merged,
      ),
      { group: "backlog", role: "paused" },
    );
  });

  it("workspace override beats default mapping", () => {
    assert.deepEqual(
      mapLinearState(
        { state: state("Awaiting QA", "backlog"), teamKey: "OPS" },
        opts(),
      ),
      { group: "backlog", role: "awaiting-external" },
    );
  });

  it("override entry without explicit group inherits the Linear type→group", () => {
    const override: OverrideEntry = { substate: "QA", role: "in-review" };
    assert.deepEqual(
      mapLinearState(
        { state: state("QA", "started"), teamKey: "DEV" },
        { teamOverrides: { DEV: [override] } },
      ),
      { group: "started", role: "in-review" },
    );
  });

  it("team override case-insensitive", () => {
    assert.deepEqual(
      mapLinearState(
        { state: state("paused", "backlog"), teamKey: "DEV" },
        opts(),
      ),
      { group: "backlog", role: "paused" },
    );
  });

  it("override does not apply when teamKey differs", () => {
    // "Paused" has no default mapping; without the DEV override it should error.
    assert.throws(
      () =>
        mapLinearState(
          { state: state("Paused", "backlog"), teamKey: "OPS" },
          opts(),
        ),
      MappingError,
    );
  });
});

describe("mapLinearState — errors", () => {
  it("throws MappingError when no override or default applies", () => {
    assert.throws(
      () => mapLinearState({ state: state("Mystery", "started") }),
      MappingError,
    );
  });
});
