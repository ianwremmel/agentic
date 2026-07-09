---
name: build-graph
description: Produce the tracker-neutral project-graph document for §2.6 orchestration — resolve the tracker's producer adapter, fetch a full sync or an incremental delta, run the shared derive engine, and update the durable graph cache. Use to refresh the graph each orchestrator tick, or standalone to inspect a project's frontier. Delegates all tracker access to a per-tracker adapter; does zero graph reasoning itself.
---

# build-graph

The §2.6 **producer**. It emits the
[project-graph document](./schema/project-graph.schema.json) the
[`work-project`](../work-project/SKILL.md) orchestrator reads — the merged graph
plus derived sections (`available` / `blocked` / `human-blocked` /
`permanently-blocked` / `milestones` / `counts` / `anomalies`). The orchestrator
invokes it **identically** regardless of tracker or access mechanism.

Two responsibilities, cleanly split:

- **Fetch/normalize** — the *only* tracker-specific step — is delegated to a
  per-tracker **adapter** (`build-graph-<tracker>`), which emits a
  [normalized graph](./schema/normalized-graph.schema.json). Adapters are added
  incrementally; the contract is [`adapters/README.md`](./adapters/README.md).
  **No adapter ships yet** — without one, build-graph `ERROR`s (see §Resolve).
- **Reason** — effective-blocking (§2.3), ranking, cycle detection, milestone
  gating, the derived sections — is done once, tracker-neutrally, by
  [`scripts/derive`](./scripts/derive). build-graph never reasons over the graph
  or reads a raw ticket body; that keeps every tracker's semantics identical.

## Inputs

Passed by the orchestrator (or a human, standalone):

| input               | meaning                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------ |
| `projects`          | one or more project identifiers, **all on the same tracker** (§2.3 forbids cross-tracker deps).   |
| `cache_path`        | durable normalized graph cache (also holds the persisted `cursor`); absent on first run.          |
| `doc_path`          | where to write the project-graph document (`-` = stdout).                                          |
| `exclude`           | ids in flight / done / failed — kept out of scheduling sections only (§2.6).                       |
| `top`               | injected ids to force to the head of `available` (§Runtime injection, orchestrator-supplied).      |
| `--sync`            | force a full sync (recovery / operator request); otherwise the mode is chosen per §Sync vs delta. |

## Resolve the tracker & adapter

The tracker comes from config `tracker` (default `linear`); all selected
projects share it. Select the adapter skill `build-graph-<tracker>`. If it is not
installed, **`ERROR` and stop** — "no producer adapter for `<tracker>`; see
`adapters/README.md`" — never fabricate graph data. Because no adapter ships in
this repo yet, that is the expected outcome of an end-to-end run today; the
tracker-neutral engine and contract are complete and an adapter drops in behind
them.

## Sync vs delta

Incremental delta is the steady state; sync is the fallback (§2.6 producer
contract):

- **Full sync** when: no `cache_path` yet (first run), `--sync` (recovery /
  operator), the adapter reports a **cursor gap**, or the adapter has no delta
  support.
- **Incremental delta** otherwise: read `cursor` from the cache
  (`jq -r .cursor <cache_path>`) and ask the adapter only for what changed since
  it. This is the per-tick path.

Exclusions are passed through but MUST NOT suppress node/edge updates — a sync or
delta still emits the current state of an excluded ticket, so the cache never
goes stale for in-flight or terminal work.

## Run

1. **Fetch** — invoke the resolved adapter for `sync` or `delta`, passing
   `projects`, the `cursor` (delta only), the configured `human_interactive`
   signal, and `exclude`. A **scripted** adapter (tracker with an API/token) is
   run directly; an **MCP-only** adapter is a fetch subagent. Either way its
   stdout is one normalized-graph JSON. Capture it to a temp file.
2. **Reason + merge + persist** — run

   ```
   scripts/derive --state <cache_path> --input <adapter-out.json> \
     --doc <doc_path> [--exclude <ids>] [--top <ids>]
   ```

   `derive` merges the input into the cache by a deterministic mechanical merge
   (sync replaces; delta upserts/removes), computes every derived section, and
   writes both the updated cache (atomically, with the new `cursor` inside) and
   the document. The cache is the cursor's single source of truth.
3. **Surface anomalies** — if the document's `anomalies` is non-empty, report it.
   A `cycle` is illegal per §2.3: surface it and do **not** paper over it. A
   `cross-project-edge` is informational (same-tracker cross-project deps are
   allowed).

## Standalone vs dispatched

Same behavior; only the caller differs. **Dispatched** — the orchestrator calls
build-graph at the top of each tick and reads `doc_path`. **Standalone** — a
human runs `/build-graph <projects>` to inspect the current frontier; print a
short summary of `available` / `blocked` / `human-blocked` / anomalies and the
per-project `counts`. Standalone writes the same cache/document (harmless and
reusable) but dispatches nothing.

## What build-graph never does

- Never computes blocking, ranking, cycles, or any derived section — that is
  `derive`'s (duplicating it is how trackers drift).
- Never reads or interprets a raw ticket body, evaluates CI/reviews, or maps
  substates to roles — the **adapter** owns substate→§2.3-role mapping, reusing
  the tracker's `work-ticket` reference mapping as the single source of truth.
- Never dispatches coordinators or workers — that is the orchestrator's.

## Config

From the plugin's `userConfig` (env `CLAUDE_PLUGIN_OPTION_*`):

| key                      | effect                                                                                         |
| ------------------------ | ---------------------------------------------------------------------------------------------- |
| `tracker`                | selects the adapter `build-graph-<tracker>` (default `linear`). All selected projects share it. |
| `human_interactive_label`| tracker label/field that marks a node `human-interactive` (§2.6); forwarded to the adapter.      |

Dependencies: `python3` (derive), `jq` (cursor read / adapter plumbing), plus
whatever the resolved adapter needs. See [`reference.md`](./reference.md) for the
document contents, the derive CLI, on-disk paths, and the adapter contract
pointer. The spec (§2.3 dependency/milestone rules, §2.6 producer contract) is
authoritative where they differ.
