---
name: build-graph
description: Produce the tracker-neutral project-graph document for one or more projects — fetch tracker state (full or since a cursor), normalize it, derive the ranked frontier, blocked sets, milestone flags, counts, and anomalies. Use when an orchestrator needs the graph, or to inspect a project's frontier standalone.
---

# build-graph

The **producer**: turn one tracker's projects into one merged, derived
project-graph document. Three steps, in order:

1. **Fetch** — tracker-specific. Full sync, or a delta since a `cursor`.
2. **Normalize** — map tracker state onto the neutral node/edge shape.
3. **Derive** — run `scripts/graph`. Never derive by hand.

## Inputs

| input      | meaning                                                                       |
| ---------- | ----------------------------------------------------------------------------- |
| `projects` | one or more project identifiers, all on **one** tracker (cross-tracker: stop) |
| `cache`    | path to the durable normalized graph (the caller's run dir)                   |
| `cursor`   | opaque, tracker-defined; absent ⇒ full sync                                   |
| `exclude`  | ids in flight, done, or failed — kept out of `available` only                 |
| `priority` | ids to rank to the top of the frontier (injected work)                        |

Full sync on first run, after a cursor gap, or when the tracker has no
changed-since query. Otherwise fetch the delta.

## 1. Fetch

Resolve the tracker from the project identifiers, falling back to
`${user_config.tracker}`.

**Prefer an adapter.** If a `graph-fetch-<tracker>` skill is installed, invoke it
and use its output as the delta. Only when none exists, fetch through the
tracker's MCP server yourself (Linear:
[`reference.md`](./reference.md#linear-via-mcp)).

An unmapped tracker is an `ERROR`, never a guess.

## 2. Normalize

Emit one delta document: `projects`, `milestones`, `nodes`, `edges`, `cursor`
([`reference.md`](./reference.md#normalized-input)). Every node carries its role
and group — map substates with the tracker's role table (Linear:
[`work-ticket/reference.md`](../work-ticket/reference.md#linear--roles)); an
unmapped substate is an `ERROR`.

Exclusions **never** suppress a node or edge update; they only affect ranking
(step 3).

## 3. Derive

```
scripts/graph merge  --cache <cache> --delta <delta.json>
scripts/graph derive --cache <cache> --exclude <ids> --priority <ids> > <document.json>
```

`merge` is a mechanical upsert; `derive` computes effective-blocking, the
milestone-review gate, ranking, cycles, and counts.

## Report

The document path, plus a one-line summary (`N available · M blocked · K
human-blocked · anomalies: …`). Surface anomalies loudly — a dependency cycle is
illegal, and its nodes are withheld from `available`. Never edit the document by
hand.
