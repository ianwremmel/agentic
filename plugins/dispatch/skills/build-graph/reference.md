# build-graph — reference

## The delta

What an adapter emits and `project-graph refresh` consumes. One tracker only.

```xml
<project-graph-delta cursor="2026-07-11T18:04:00Z" full="false">
  <projects>
    <project id="proj-api" name="API v2"/>
  </projects>
  <milestones>
    <milestone id="m1" project="proj-api" name="Schema" order="1" review-recorded="false"/>
  </milestones>
  <nodes>
    <node id="DEV-12" url="https://…" title="Add the schema" role="available" group="unstarted"
          project="proj-api" milestone="m1" target-kind="pr" human-interactive="false"
          dead="false" priority="100" branch-hint="dev-12-schema">
      <label name="needs-human"/>
      <pr url="https://github.com/o/r/pull/7"/>
    </node>
  </nodes>
  <edges>
    <edge blocker="DEV-11" blocked="DEV-12"/>
    <edges-for node="DEV-12"/>
  </edges>
</project-graph-delta>
```

| attribute           | notes                                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------------ |
| `full`              | `true` ⇒ the cache is replaced wholesale. A delta omits it.                                       |
| `cursor`            | opaque, tracker-defined. Persisted in the cache and passed back next fetch.                       |
| `title`             | one line. The orchestrator prints it in its status table; it never reads a ticket body.           |
| `role` / `group`    | the protocol's vocabulary, never a tracker substate. An unmapped substate is an `ERROR`.          |
| `order`             | milestone sequence within its project. Drives the review gate.                                    |
| `review-recorded`   | a review recorded **since the milestone last gained a ticket**, so a review that filed follow-ups re-opens the gate. |
| `target-kind`       | `pr` \| `verification` \| `human-only`.                                                           |
| `human-interactive` | the configured tracker signal. Parked roles are detected separately.                              |
| `dead`              | terminated **without** `verified` and will not progress — the configured abandoned/failed signal. A `canceled` ticket is **not** dead: cancellation unblocks its dependents. |
| `<edges-for node>`  | this delta restates that node's edges in full; cached edges touching it are dropped first, so a deleted dependency cannot survive. Omit it and edges are additive only. |
| `removed="true"`    | on a node/milestone/project/edge: delete it from the cache.                                       |

An edge naming a node the delta never emits is **kept**: it means the blocker is
outside the synced set. Dropping it would report blocked work as ready, so
`derive` blocks the dependent and raises an `unknown-blocker` anomaly.

## The document

`<run-dir>/document.xml` — what the orchestrator reads. Every section is emitted
even when empty; a missing one would read as "nothing to do".

| section                 | contents                                                                                     |
| ----------------------- | ---------------------------------------------------------------------------------------------- |
| `<available>`           | ranked ticket ids eligible for dispatch                                                       |
| `<blocked>`             | workable but blocked (ancestor, milestone gate, or unknown blocker)                           |
| `<human-blocked>`       | `human-interactive`, `target-kind="human-only"`, or parked in `awaiting-external`              |
| `<permanently-blocked>` | dead, or descended from a dead node                                                           |
| `<stalled>`             | workable, not in flight, and in no other section — `backlog` or `paused`. Nothing will dispatch these, and they hold `remaining` above zero |
| `<milestones>`          | `ready-for-review`, `review-recorded`, `order`, counts                                        |
| `<counts>`              | `total`, `verified`, `canceled`, `permanently-blocked`, `remaining`, `terminal` — per project, per milestone, and overall |
| `<anomalies>`           | `cycle`, `cross-project-cycle`, `unknown-blocker`, `unknown-milestone`                        |
| `<nodes>`               | every node with its derivation tags, `url`, and `title` — the status table's source           |

## Derivation rules

- **Effectively blocked** — any ancestor whose role is not `verified`/`canceled`
  (transitive), an open milestone gate, or a blocker outside the synced set.
- **Cancellation unblocks.** A `canceled` ancestor does not block its dependents;
  a `dead` one blocks them permanently.
- **Milestone gate** — a node in milestone M is blocked while any earlier
  **non-empty** milestone of its project is not both `ready-for-review` and
  `review-recorded`. An empty milestone has no review to run, so gating on one
  would deadlock the project.
- **Ready for review** — every ticket in the milestone is terminal and so is every
  ancestor of one. A member with an unknown blocker holds the milestone back.
- **Rank** — injected first, then `priority` (**lower sorts first**; default 100),
  milestone order, how much the ticket unlocks, then id. Total and stable.
- **Available** — workable, unblocked, not parked, not human-blocked, not in a
  cycle, not in `backlog`, not excluded.
- **`paused` is not a human handoff** — it means stopped for other priorities, so
  it lands in `<stalled>`. A tracker whose park substate means "waiting on a
  human" maps it to `awaiting-external`.
- **Nothing is terminal until it exists** — an empty project is not a complete
  one, so a fetch that returns no nodes cannot end the run.

## Adapter contract

A per-tracker adapter is a skill named `graph-fetch-<tracker>`
([`graph-fetch-linear`](../graph-fetch-linear/SKILL.md)). Given `projects`, an
optional `cursor`, and an output path, it writes one delta and prints the path.
Nothing else — no derivation, no cache. Adding a tracker is adding one adapter
plus its role table.
