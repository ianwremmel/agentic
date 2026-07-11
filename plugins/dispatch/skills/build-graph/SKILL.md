---
name: build-graph
description: Produce the tracker-neutral project-graph document for one or more projects — fetch tracker state via the tracker's adapter, merge it into the run's cache, and derive the ranked frontier, blocked sets, milestone flags, counts, and anomalies. Use when an orchestrator needs the graph, or to inspect a project's frontier standalone.
---

# build-graph

The **producer**: turn one tracker's projects into one merged, derived
project-graph document.

## Inputs

`projects` (one or more ids, all on **one** tracker — mixed trackers: stop) and
the run directory. Everything else is state: the cursor lives in the cache, and
the exclusions and injected priorities come from the run's active set.

## 1. Fetch (the tracker's adapter)

Resolve the tracker from the projects, falling back to
`${user_config.tracker}`. Invoke `graph-fetch-<tracker>` — Linear:
[`graph-fetch-linear`](../graph-fetch-linear/SKILL.md) — with the projects, the
cursor from `<run-dir>/graph.json`, and an output path. It writes one
`<project-graph-delta>` ([`reference.md`](./reference.md#the-delta)).

No adapter for the tracker is an `ERROR` — never improvise one.

## 2. Merge + derive

```
project-graph refresh --run-dir <run-dir> --delta <delta.xml>
```

Merges the delta into the cache, then writes `<run-dir>/document.xml` and prints
its path. `refresh` is the whole step — never merge or derive by hand.

To re-derive without fetching, after the active set changed:
`project-graph derive --run-dir <run-dir>`.

## Report

The document path and a one-line summary: `N available · M blocked · K
human-blocked · S stalled · anomalies: …`.

Surface anomalies loudly: they withhold work from the frontier, so never report
an empty frontier as "nothing to do". Never edit the document by hand.
