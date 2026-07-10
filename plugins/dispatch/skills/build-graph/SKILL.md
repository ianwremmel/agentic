---
name: build-graph
description: Build the tracker-neutral project-graph document for §2.6 orchestration — fetch the selected projects' tickets, milestones, and dependency edges from the tracker, map each ticket to its §2.3 role, merge into one dependency graph spanning every project, and emit the derived frontier (available / blocked / human-blocked / permanently-blocked / milestones / counts / anomalies) as XML. Use to refresh the graph each work-project tick, or standalone to inspect a project's frontier.
---

# build-graph

The §2.6 **producer**. It emits the one document the
[`work-project`](../work-project/SKILL.md) orchestrator reads: a **tracker-neutral
project-graph** — the merged graph plus the *derived* sections the orchestrator
acts on directly. All graph **reasoning** happens here, so the orchestrator never
re-derives blocking, ranking, or cycles and never parses a raw ticket body.

This skill **works as-is today**: the agent fetches from the tracker (Linear via
MCP) and reasons over the result in-context. Determinism and speed come later —
see [§Later](#later-determinism--per-tracker-adapters). The document shape is
fixed now so `work-project` depends only on it, not on how it was produced.

## Inputs

Passed by the orchestrator (or a human, standalone):

| input      | meaning                                                                                         |
| ---------- | ----------------------------------------------------------------------------------------------- |
| `projects` | one or more project identifiers, **all on the same tracker** (§2.3 forbids cross-tracker deps). |
| `doc_path` | where to write the project-graph XML (`-` = stdout).                                            |
| `cursor`   | opaque "changed-since" marker from the last build, for an incremental refresh (optional).       |
| `exclude`  | ids in flight / done / failed — kept out of the scheduling frontier only (§2.6).                |
| `top`      | injected ids to force to the head of `available` (orchestrator-supplied injection).             |

## Resolve the tracker

The tracker comes from config `tracker` (default `linear`); all selected projects
share it. **Only `linear` is implemented today** (via Linear MCP), matching
[`work-ticket`](../work-ticket/SKILL.md); a project on any other tracker →
`ERROR` and stop. The Linear substate→§2.3-role mapping is the one in
[`work-ticket/reference.md`](../work-ticket/reference.md) — the single source of
truth; reuse it, never invent a second.

## Fetch

Pull the raw state for every selected project from the tracker:

- **Tickets** — id, url, project, milestone, tracker substate, dependency edges
  (`blockedBy`/`blocks`), the configured `human_interactive` label/field, and any
  branch-name hint.
- **Milestones** — id, project, a **total order per project** (needed to gate
  later milestones on earlier reviews), and the tracker's `ready-for-review` /
  `review-recorded` signals.

**Full refresh** builds everything for the selected projects; use it on the first
build, on recovery, or when no `cursor` is supplied. **Incremental refresh** —
when a `cursor` is supplied and the tracker supports "changed since" — fetches
only what changed and updates the prior document; it is the steady state. Either
way, an `exclude`d ticket's state is still fetched and reflected in node tags — it
is only withheld from the scheduling frontier, never from the graph.

## Map & merge

Map each ticket's substate to its §2.3 `role`/`group` (the mapping above), then
merge all projects into **one** dependency graph. Same-tracker cross-project edges
are kept; a cross-tracker edge is illegal (§2.3) and must not exist.

## Reason (the derived sections)

Compute these so the orchestrator does not have to. Rules are normative:

| rule                       | behavior                                                                                                                                                                                                                                                                            |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| dependency-blocking (§2.3) | a ticket is **blocked** if any direct predecessor is not `verified`/`canceled` — only those two roles clear a dependency.                                                                                                                                                           |
| cancellation unblocks      | a `canceled` predecessor never blocks and never causes a permanent block; its dependents move toward `available`.                                                                                                                                                                   |
| milestone gate (§2.3)      | a ticket is **blocked** while any earlier milestone (lower `order`, same project) is not yet review-gate-open (below).                                                                                                                                                              |
| stale-review guard (§2.6)  | a milestone with unresolved work is **not** `ready-for-review`; a not-ready milestone is **not** `review-recorded` — so §2.3's re-review is never suppressed by a stale record. A milestone's gate is open only when it is complete, `ready-for-review`, **and** `review-recorded`. |
| permanent-block            | a ticket is **permanently-blocked** if it is itself dead (a terminal that is neither `verified` nor `canceled` and will not progress) or is gated behind such a dead predecessor (transitively).                                                                                    |
| ranking                    | order `available` by earliest milestone, then by **unblocking leverage** (how many tickets it transitively frees), then id, for a stable frontier. Force `top` (injected) ids to the head.                                                                                          |
| exclusion (§2.6)           | `exclude`d ids are omitted from `available` only; they still appear in the graph with their current state.                                                                                                                                                                          |
| anomalies                  | surface `cycle` (illegal per §2.3 — never work around) and `cross-project-edge` (informational).                                                                                                                                                                                    |
| completion                 | a project is terminal when every ticket is `verified`/`canceled`/permanently-blocked; the document reports it.                                                                                                                                                                      |

## Emit

Write the project-graph as **XML** (the house serialization, per §2.2's
`pr-status`), containing the node tags and the derived sections
`available` / `blocked` / `human-blocked` / `permanently-blocked` / `milestones` /
`counts` / `anomalies`, plus the latest `cursor`. The exact element/attribute shape
is in [`reference.md`](./reference.md#project-graph-document). Surface any
`anomalies` to the caller; a `cycle` is illegal — do not paper over it.

## Standalone vs dispatched

Same behavior; only the caller differs. **Dispatched** — `work-project` calls
build-graph at the top of each tick and reads `doc_path`. **Standalone** — a human
runs `/build-graph <projects>` to inspect the frontier; print a short summary of
`available` / `blocked` / `human-blocked` / anomalies and the per-project counts.
Standalone dispatches nothing.

## What build-graph never does

- Never dispatches coordinators or workers — that is the orchestrator's.
- Never evaluates CI/reviews or drives a PR — that is `deliver`'s (§2.4).
- Never leaks a raw ticket body upward — the orchestrator sees only roles and the
  derived sections, so it stays thin.

## Later: determinism & per-tracker adapters

The document is the stable contract; *how* it is produced hardens over time,
without changing anything above it:

- **Per-tracker fetch adapters.** The only tracker-specific step is fetch +
  substate→role mapping. A tracker with an API and a token (Linear, Jira, GitHub
  Issues) can be a **scripted** adapter emitting a normalized graph; a tracker
  reachable only through MCP (e.g. Asana) stays an **agent-driven** fetch. Both
  feed the same reasoning, so the orchestrator is unaffected.
- **A deterministic reasoning engine.** The §Reason rules are mechanical and can
  move into a script that takes the normalized graph and emits the document, once
  the shape has settled in practice.

Neither exists yet, and neither is required for the skill to work — they add speed
and determinism, not capability.

## Config

From the plugin's `userConfig` (env `CLAUDE_PLUGIN_OPTION_*`):

| key                       | effect                                                                      |
| ------------------------- | --------------------------------------------------------------------------- |
| `tracker`                 | which tracker to fetch (default `linear`; only `linear` implemented today). |
| `human_interactive_label` | tracker label/field that marks a node `human-interactive` (§2.6).           |

See [`reference.md`](./reference.md) for the XML document shape, the reasoning
rules, and the role-mapping pointer. The spec (§2.3 dependency/milestone rules,
§2.6 producer contract) is authoritative where they differ.
