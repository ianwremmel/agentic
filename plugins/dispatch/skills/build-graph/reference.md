# build-graph — reference

Lookup tables for [`SKILL.md`](./SKILL.md), bundled so the skill is
self-contained. The spec is authoritative where they differ: §2.3 Ticket Workflow
(roles, dependencies, milestones), §2.6 Orchestration (producer contract).

## Roles

- **build-graph** — this skill; the §2.6 producer coordinator. Selects an adapter,
  runs the fetch, runs `derive`, updates the cache + document. No graph reasoning.
- **adapter** — a per-tracker `build-graph-<tracker>` skill; the only
  tracker-specific part. Fetches + normalizes to
  [`normalized-graph`](./schema/normalized-graph.schema.json). None ship yet;
  contract in [`adapters/README.md`](./adapters/README.md).
- **derive** — [`scripts/derive`](./scripts/derive); tracker-neutral engine. Merges
  the normalized input and emits the
  [`project-graph`](./schema/project-graph.schema.json) document.
- **orchestrator** — [`work-project`](../work-project/SKILL.md); the sole
  dispatched caller. Reads the document; never calls the adapter directly.

## The derive CLI

```
derive --state <cache.json> --input <adapter-out.json|-> \
       [--doc <out.json|->] [--exclude id,id,...] [--top id,id,...]
```

- `--state` — durable graph cache (read + atomically rewritten). Holds the
  `cursor` (single source of truth). Absent ⇒ first-run empty cache.
- `--input` — the adapter's normalized `sync` or `delta` (schema
  `dispatch/normalized-graph@1`).
- `--doc` — where the `dispatch/project-graph@1` document is written (`-` stdout).
- `--exclude` — ids kept out of `available` only (in-flight/done/failed); their
  node state is still merged and emitted.
- `--top` — injected ids forced to the head of `available` (already-blocked ids
  are ignored — injection never overrides blocking).

Stdlib-only Python 3. Exit 2 on bad input/schema.

## What derive computes (so no one else does)

| rule                       | behavior                                                                                                    |
| -------------------------- | ----------------------------------------------------------------------------------------------------------- |
| dependency-blocking (§2.3) | blocked iff any direct `blocked_by` is not `verified`/`canceled`. Only those two roles clear a dependency.    |
| cancellation unblocks      | a `canceled` ancestor never blocks and never causes permanent-block; dependents move toward `available`.     |
| milestone gate (§2.3)      | a node is blocked while any earlier milestone (lower `order`, same project) is not review-gate-open.          |
| stale-review guard (§2.6)  | an incomplete milestone is forced `ready_for_review=false`; a not-ready one is forced `review_recorded=false`. |
| permanent-block            | a node (transitively) gated behind a `terminated_without_verify` (non-canceled) ancestor, or itself dead.    |
| ranking                    | `available` sorted by milestone `order`, then descending unblock-leverage (transitive dependents), then id.   |
| exclusion (§2.6)           | excluded ids omitted from `available` only; still merged/emitted.                                            |
| anomalies                  | `cycle` (illegal, §2.3 — surface, don't work around) and `cross-project-edge` (informational).               |
| completion                 | `counts.all_terminal` true when every project's `remaining` (total − verified − canceled − perm-blocked) is 0. |

## On-disk paths

The orchestrator owns the base and passes concrete paths; build-graph writes only
what it is told. Conventional layout under the run directory
(`${DISPATCH_CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/dispatch}/work-project/<run-key>/`):

| file          | written by | holds                                                     |
| ------------- | ---------- | --------------------------------------------------------- |
| `graph.json`  | `derive`   | durable normalized cache **+ `cursor`** (single source)   |
| `doc.json`    | `derive`   | the project-graph document the orchestrator reads          |

`<run-key>` identifies the selected project set (the orchestrator derives it,
e.g. a stable hash of the sorted project ids). Standalone runs may use any base.

## Adding a tracker

1. Write `build-graph-<tracker>/SKILL.md` satisfying
   [`adapters/README.md`](./adapters/README.md): fetch + map substates to §2.3
   roles (reuse that tracker's `work-ticket` reference mapping), emit
   `normalized-graph` for `sync` and (ideally) `delta`, return an opaque cursor.
2. Validate its output against
   [`schema/normalized-graph.schema.json`](./schema/normalized-graph.schema.json)
   and run a fixture through `derive`, checking the derived sections by hand.
3. No change to `derive`, `build-graph`, or `work-project` is needed — the whole
   point of the split.
