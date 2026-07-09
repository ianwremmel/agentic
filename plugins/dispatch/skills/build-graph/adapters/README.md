# build-graph adapters — the producer fetch/normalize contract

A **producer adapter** is the *only* tracker-specific part of §2.6 graph
building. It answers one question — *"what does this tracker's project state look
like, as a tracker-neutral snapshot?"* — and hands the answer to the shared,
deterministic [`../scripts/derive`](../scripts/derive), which does **all** graph
reasoning (effective-blocking, ranking, cycles, milestone gating, derived
sections). Adapters do none of that.

No adapter ships yet. This document is the contract a per-tracker adapter skill
implements. Adapters are added incrementally, one skill per tracker; adding a
tracker is a new adapter, never a change to `derive` or the orchestrator.

## What an adapter is

A skill named `build-graph-<tracker>` (e.g. `build-graph-linear`,
`build-graph-asana`, `build-graph-github-issues`, `build-graph-jira`). The
[`build-graph`](../SKILL.md) coordinator selects it from the resolved `tracker`
and invokes it for a **fetch**. The adapter's sole output is a
[`normalized-graph`](../schema/normalized-graph.schema.json) document
(`kind: "sync"` or `kind: "delta"`) on stdout.

## The two operations

| op        | when                                                              | must emit                                                                           |
| --------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| **sync**  | first run, recovery, cursor gap, or no delta support             | the COMPLETE normalized graph for the selected projects; a fresh `cursor`            |
| **delta** | steady state — every tick where the tracker supports incremental | only nodes/milestones/projects changed since the input `cursor`, plus `removed`; a new `cursor` |

Inputs the coordinator passes: the selected project identifiers, the persisted
`cursor` (empty on first run), the configured `human_interactive` label/field,
and the set of exclusion ids (in-flight/done/failed) — though exclusions affect
only `derive`'s scheduling sections, so an adapter MAY ignore them and MUST still
emit the current state of an excluded ticket (§2.6: the cache must never go stale
for in-flight or terminal work).

## Hard requirements

An adapter **MUST**:

1. **Map substates to §2.3 roles/groups itself.** The normalized `role`/`group`
   are §2.3 vocabulary, not tracker substates. Reuse the same
   substate→role mapping the tracker's `work-ticket` reference defines — it is
   the single source of truth for that tracker (e.g. Linear's is in
   [`../../work-ticket/reference.md`](../../work-ticket/reference.md)). Only
   `verified` and `canceled` are treated as dependency-clearing downstream, so
   map terminal substates precisely.
2. **Supply a total milestone `order` per project.** `derive` gates later
   milestones on earlier ones' review using this order; without it the §2.3
   milestone-review sequencing cannot be enforced.
3. **Emit dependency edges as `blocked_by`.** Same-tracker cross-project edges
   are allowed (surfaced as anomalies); a cross-tracker edge is illegal (§2.3)
   and MUST NOT be emitted.
4. **Set `target_kind`** to `pr`, `verification`, or `human-only`, and
   **`human_interactive`** from the configured tracker signal (§2.6).
5. **Set `terminated_without_verify`** on a ticket that reached a dead terminal
   that is neither `verified` nor `canceled` and will not progress — and MUST NOT
   set it on a `canceled` ticket (cancellation unblocks, per §2.3/§2.6).
6. **Pass the tracker signals `ready_for_review`/`review_recorded` raw.**
   `derive` owns the stale-review guard (forcing them false for incomplete or
   not-ready milestones); an adapter MUST NOT pre-suppress them.
7. **Return an opaque `cursor`** the tracker can later interpret as "changed
   since" (Linear `updatedAt`, Jira `updated`, GitHub `since`, …). It is opaque
   to everything above the adapter.

An adapter **MUST NOT** compute blocking, ranking, cycle detection, or any
derived section — those are `derive`'s, and duplicating them is how trackers
drift apart.

## Access style is orthogonal to credential mode

How the adapter reaches the tracker — API, CLI, or MCP — is an adapter detail
selected by configuration. It has nothing to do with §2.1 Mode A/B, which governs
*whose identity acts* and *how human input is routed*. Any mode may be served by
any access style. Concretely:

- A tracker with a token and an API (Linear, Jira, GitHub Issues) can be a
  **scripted** adapter — a CLI/library call that emits the JSON directly, fast
  and cheap, suitable for tight delta ticks.
- A tracker reachable only through MCP (e.g. Asana today) is an **agent-driven**
  adapter — an MCP-fetch subagent that gathers state and emits the same JSON. It
  is slower and looser but satisfies the identical contract, so nothing above it
  changes.

The orchestrator and `build-graph` invoke either identically.

## Validation

Validate an adapter's output against
[`../schema/normalized-graph.schema.json`](../schema/normalized-graph.schema.json)
and feed a representative fixture through `derive` to confirm the derived
sections match hand-computed expectations before wiring the adapter into
`build-graph`.
