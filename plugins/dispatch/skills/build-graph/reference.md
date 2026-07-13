# build-graph — reference

## Commands

| Command                                          | Does                                                                        |
| ------------------------------------------------ | --------------------------------------------------------------------------- |
| `graph ingest [--full] [--tracker t] --file p`   | Merge one fetch. `--full` replaces the graph outright.                      |
| `graph doc [--format xml\|json]`                 | Emit the derived project-graph document on stdout.                          |
| `graph cursor get\|set --source t [--value v]`   | Read/write the opaque changed-since token. Empty on `get` means: full sync. |
| `graph exclude add\|remove\|list --id t --kind k`| Tickets the orchestrator owns: `in-flight`, `done`, `failed`.               |
| `graph record-review --milestone m`              | Record that a milestone's review ran.                                       |

Common flags: `--db <path>` (default `$DISPATCH_GRAPH_DB`, else
`~/.cache/dispatch/graph.sqlite`), `--config <path>`, `--quiet`, `--verbose`.

## Exit codes

| Code | Means                    | What to do                                                                       |
| ---- | ------------------------ | -------------------------------------------------------------------------------- |
| 0    | Success                  | —                                                                                |
| 2    | Bad invocation           | You called it wrong — a bad flag, or a malformed payload. Fix the call.          |
| 3    | Bad environment          | Node missing/too old, or the database is unreadable. **Escalate to the operator.** |
| 4    | Data needs configuration | An unmapped tracker state. Add it to the config, or escalate. **Never guess.**   |

Every failure prints the problem and a `remedy:` line naming the next action.

## Roles

The protocol's vocabulary. A tracker's native states map onto these.

| Role                | Group       | Means                                              |
| ------------------- | ----------- | -------------------------------------------------- |
| `backlog`           | `backlog`   | Not ready to work on. Not eligible to be picked up.|
| `paused`            | `backlog`   | Started, then stopped for other priorities.        |
| `awaiting-external` | `backlog`   | Parked pending something outside the agent.        |
| `available`         | `unstarted` | Eligible to be picked up.                          |
| `in-progress`       | `started`   | An agent is working it.                            |
| `in-review`         | `started`   | Iterating with reviewers.                          |
| `finished`          | `started`   | Approved, not yet merged.                          |
| `delivered`         | `started`   | Merged, not yet verified.                          |
| `verified`          | `completed` | Validated against the ticket's aims.               |
| `canceled`          | `canceled`  | Abandoned. Will not be done.                       |

## How a ticket is classified

Highest precedence first. A ticket lands in exactly one bucket.

| Bucket                | When                                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------- |
| `verified`/`canceled` | Terminal role, or a `done` exclusion.                                                       |
| `permanently-blocked` | A `failed` exclusion, or an ancestor with one — it will never progress.                     |
| `in-flight`           | An `in-flight` exclusion, or a `started`-group role.                                        |
| `dormant`             | Role is `backlog`.                                                                          |
| `blocked`             | Any unresolved ancestor, or an earlier milestone still awaiting review.                     |
| `human-blocked`       | Labelled human-interactive, or parked in `awaiting-external`/`paused`.                      |
| `available`           | Role is `available` and nothing above applies. Ranked.                                      |

Three consequences worth knowing:

- **`dormant` outranks every scheduling bucket.** A `backlog` ticket is not
  eligible to be picked up whatever else is true of it, so it never reads as
  `blocked` (which would imply clearing its blockers makes it workable — it does
  not; a human must promote it first) or as `human-blocked` (which would alert a
  human to work nobody has started). `paused` and `awaiting-external` are *not*
  this: they are parked mid-flight, and do land in `human-blocked`.
- **`blocked` outranks `human-blocked`.** A human-interactive ticket whose
  blockers are still open reads as `blocked` — so nobody alerts a human about work
  that is not yet actionable. It flips the moment its ancestors resolve.
- **A `canceled` ancestor unblocks its dependents.** Cancellation releases
  downstream work; it never permanently blocks it. Only a `failed` exclusion
  does that.

`dormant` tickets do not hold a project open: a `backlog` ticket is not eligible
to be picked up, so waiting on one would mean ticking forever until a human
promotes it. A project whose tickets are *all* in the tracker's backlog is
therefore `terminal` with an empty frontier — correctly: there is nothing to
dispatch until a human promotes some of it. Everything else outstanding does keep
a project non-terminal, including a human handoff.

A `partial="true"` project was never fetched — it was inferred from a
cross-project ancestor that named it. Only the tickets reachable as ancestors were
pulled in, so its counts describe those tickets and nothing more, and it is never
`terminal`. Completion is judged on the projects you actually selected.

## Effective blocking

A ticket is blocked if **any** ticket in its transitive ancestor closure is not
`verified` or `canceled`. The walk is not pruned at a resolved ancestor: a
`verified` ticket that is itself still blocked keeps blocking its dependents.
This is deliberately conservative — the alternative dispatches work whose real
blocker is still open.

An **unfetched** ancestor counts as unresolved and propagates like any other. A
blocker nobody has seen cannot be assumed done, and it must not disappear from
the reasoning just because the ticket in front of it got marked `verified`.

A ticket on a cycle is its own ancestor, so it comes out blocked with no
special-casing. Cycles are still reported as anomalies, and must be surfaced, not
scheduled around.

The `blocked-by` attribute lists **every** unresolved ancestor — the transitive
set, not just the direct blockers — because that is the set the blocking decision
was actually made on. On a deep chain it can be long.

`effective-blocked` on a node is a fact about the graph and is **not** the same
as `state="blocked"`: a ticket can be effectively blocked and still classify
elsewhere (a `verified` ticket whose own ancestor is open; a `dormant` backlog
ticket with blockers). Schedule off `state`; read `effective-blocked` to
understand why.

## Ranking

The `available` frontier is ranked, most urgent first:

1. **Injected** work (runtime-injected tickets and PRs).
2. **Priority** — lower is more urgent; absent sorts last.
3. **Fan-out** — how many tickets this one transitively unblocks. Keeps the
   critical path moving instead of finishing leaves.
4. **Id**, so the order is stable when everything else ties.

Milestone order is deliberately *not* part of the ranking. Milestone sequencing
is enforced by the gate below — a later milestone's tickets are *blocked*, so
they cannot reach the frontier early no matter how they sort.

## Milestone gates

A milestone is **ready for review** when every member is `verified`/`canceled`
*and* no unresolved ticket is a dependency of any member. An empty milestone is
never ready.

A ticket is **gated** — reported `blocked` — while any earlier milestone in its
project is not both ready-for-review and review-recorded. Complete is not the
same as reviewed.

`graph record-review --milestone <id>` records a review against the milestone's
**current member set**. If a review files follow-up tickets into the milestone,
the member set changes and the recorded review no longer counts: the milestone
reopens and must be reviewed again once it re-completes. A stale review record
can never suppress the re-review.

## Config file

`--config <path>`, or the `graph_config` plugin option. All keys optional.

```json
{
  "states": { "Ready for QA": "in-review" },
  "humanInteractiveLabels": ["human-led", "human-interactive"],
  "verificationLabels": ["verification"],
  "parkedRoles": ["awaiting-external", "paused"]
}
```

`states` is the **team override**: it wins over the tracker's default mapping.
Resolution is team override → tracker default → error. Add an entry here when a
team has a custom status the defaults do not know.

## Payload example

```json
{
  "cursors": { "linear:a1b2": "2026-07-11T09:12:04.000Z" },
  "projects": [{ "id": "a1b2", "name": "Switchboard" }],
  "milestones": [
    { "id": "m1", "project": "a1b2", "name": "M1 — Server-rendered UI", "sortOrder": -9 },
    { "id": "m2", "project": "a1b2", "name": "M2 — Auth", "sortOrder": 1049 }
  ],
  "nodes": [
    {
      "id": "CLC-945",
      "project": "a1b2",
      "url": "https://linear.app/acme/issue/CLC-945",
      "title": "Decide Remix codegen mounting",
      "state": "In Progress",
      "milestone": "m1",
      "labels": [],
      "priority": 2,
      "branchHint": "clc-945-decide-remix-codegen-mounting",
      "updatedAt": "2026-07-11T09:12:04.000Z",
      "blockedBy": ["CLC-917"],
      "blocks": ["CLC-948"]
    },
    { "id": "CLC-917", "project": "a1b2", "state": "Todo", "milestone": "m1", "labels": ["human-led"] }
  ]
}
```

## Document

```xml
<project-graph cursor="linear:a1b2=2026-07-11T09:12:04.000Z">
  <projects><project id="a1b2" name="Switchboard" partial="false" terminal="false"/></projects>
  <nodes>
    <node id="CLC-945" project="a1b2" url="…" role="in-progress" group="started"
          milestone="m1" target-kind="pr" human-interactive="false"
          effective-blocked="true" state="blocked" branch-hint="…"/>
  </nodes>
  <edges><edge blocker="CLC-917" blocked="CLC-945"/></edges>
  <available><ticket id="CLC-917" rank="1" target-kind="human-only" url="…"/></available>
  <blocked><ticket id="CLC-945" blocked-by="CLC-917" gated-by=""/></blocked>
  <human-blocked><ticket id="CLC-917" url="…" role="available" reason="explicit"/></human-blocked>
  <permanently-blocked/>
  <milestones>
    <milestone id="m1" project="a1b2" name="M1 — Server-rendered UI"
               ready-for-review="false" review-recorded="false" open="2" total="7"
               fingerprint="f4eb58da8d8cd3ac"/>
  </milestones>
  <counts>
    <project id="a1b2" partial="false" total="7" available="1" blocked="1"
             human-blocked="1" permanently-blocked="0" in-flight="0" dormant="0"
             verified="4" canceled="0" terminal="false"/>
  </counts>
  <anomalies>
    <anomaly kind="cycle" nodes="CLC-1,CLC-2">dependency cycle: CLC-1 -&gt; CLC-2 -&gt; CLC-1</anomaly>
  </anomalies>
</project-graph>
```

`terminal="true"` on a project means nothing is left to act on — now or after
anything else resolves. `partial="true"` means the project was never fetched, only
inferred from a cross-project ancestor; it is never terminal.

`blocked-by` is the full unresolved-ancestor set, not just the direct blockers.

Anomaly kinds:

| Kind                     | Means                                                                                                       |
| ------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `cycle`                  | Illegal. Surface it; never schedule around it.                                                              |
| `dangling-edge`          | An edge names a ticket that was never fetched. A missing *blocker* holds its dependent blocked; a missing *dependent* schedules nothing. Fetch it. |
| `cross-project-reverse`  | Two projects block each other, so neither can be finished first.                                            |
| `unknown-milestone`      | A ticket sits in a milestone that was never fetched, so its gate cannot be evaluated and it is **not** gated on any earlier milestone. Fetch the milestone. |

An **empty graph is not terminal**. Nothing has been ingested yet, which is not
the same as everything being finished.
