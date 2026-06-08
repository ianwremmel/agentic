# orchestrate — protocol reference

The project-graph wire format, slot ledger, and dispatch bookkeeping
`orchestrate` relies on. With [`SKILL.md`](./SKILL.md), this is the complete
**operating** authority for the skill — enough to run it without re-reading the
spec — but where these files and the spec differ, the normative spec governs. It
implements the Orchestration Protocol (§2.6) on top of the §2.5 coordinator, the
§2.4 delivery worker, and the §2.3 ticket workflow.

The orchestrator reads project state **only** from the project-graph document
(§Project-graph document) and the on-disk bookkeeping below. It never reads a
raw ticket body, evaluates CI/review state, or performs a milestone review — those
belong to the coordinator and the milestone-review agent.

## Project-graph document

A **producer** emits this document; the orchestrator consumes it. The protocol
fixes the *logical contents* (§2.6 §The project-graph document) but leaves the
serialization to the producer/orchestrator pair. This skill pins that
serialization to **XML**, in the same spirit as `dispatch pr-status` (§2.2): a
single well-formed UTF-8 document, attributes for scalar node facts, child
elements for derived sections, `cache="<abs-path>"`-style pointers where a node
refers to durable detail.

The producer performs **all** graph reasoning — effective-blocking (§2.3),
ranking, cycle detection — before the document reaches the orchestrator. The
orchestrator MUST treat the derived sections as authoritative and MUST NOT
re-derive blocking, ranking, or cycle detection itself.

### Root and `<project>`

```xml
<project-graph mode="full|delta" cursor="<opaque-cursor>" since="<prior-cursor>|-">
  <project id="<project-id>" tracker="linear|jira|github|..." name="<display>">
    <ticket .../>
    ...
  </project>
  ...
  <available>...</available>
  <blocked>...</blocked>
  <human-blocked>...</human-blocked>
  <permanently-blocked>...</permanently-blocked>
  <milestones>...</milestones>
  <counts>...</counts>
  <anomalies>...</anomalies>
</project-graph>
```

`<project-graph>` root attributes:

| Attribute | Type          | Requirement                        | Meaning                                                               |
| --------- | ------------- | ---------------------------------- | --------------------------------------------------------------------- |
| `mode`    | `full\|delta` | REQUIRED                           | Whether this document is a complete sync or a `--since` delta         |
| `cursor`  | string        | REQUIRED                           | Opaque new cursor to persist and pass back on the next delta call     |
| `since`   | string        | REQUIRED on `delta`; `-` on `full` | The prior cursor this delta was computed against; `-` for a full sync |

All selected projects MUST share one tracker (§2.6); cross-tracker orchestration
is out of scope. `tracker` is informational — the orchestrator never branches on
it; the producer adapter already absorbed tracker differences.

### `<ticket>` node

One `<ticket>` per ticket, nested under its owning `<project>`. Carries the
node facts the orchestrator may act on. The orchestrator MUST NOT reason over
ticket *content*: `labels` is consumed **only** as the source of the configured
`human-interactive` signal, never to infer anything about the work.

| Attribute / child   | Type                           | Requirement                                           | Meaning                                                                                                                                                         |
| ------------------- | ------------------------------ | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                | string                         | REQUIRED                                              | Tracker-stable ticket identifier                                                                                                                                |
| `url`               | string                         | REQUIRED                                              | Full ticket URL (used verbatim in §2.3 operational log entries)                                                                                                 |
| `role`              | §2.3 role token                | REQUIRED                                              | Current §2.3 workflow role (`backlog`, `available`, `in-progress`, `in-review`, `finished`, `delivered`, `verified`, `canceled`, `awaiting-external`, `paused`) |
| `group`             | string                         | REQUIRED                                              | §2.3 dependency group the ticket belongs to                                                                                                                     |
| `milestone`         | string                         | REQUIRED if the ticket is in a milestone; else absent | Milestone membership (matches a `<milestone id>` below)                                                                                                         |
| `effective-blocked` | `true\|false`                  | REQUIRED                                              | §2.3 effective-blocked status (producer-computed; a `canceled` ancestor does NOT block — see below)                                                             |
| `human-interactive` | `true\|false`                  | REQUIRED                                              | `true` iff a configured tracker signal (mapped from `labels`) marks the node human-interactive (§2.6)                                                           |
| `target-kind`       | `pr\|verification\|human-only` | REQUIRED                                              | What working the ticket produces: PR(s), a no-PR verification, or human-only work that is never dispatched                                                      |
| `<labels>`          | `<label>` children             | OPTIONAL                                              | Raw tracker labels; consumed only to derive `human-interactive`                                                                                                 |
| `branch-seed`       | string                         | OPTIONAL                                              | Non-authoritative dispatch hint — a branch-name seed passed through to the coordinator                                                                          |

A `canceled` ancestor **unblocks** its dependents (§2.3 effective-blocking):
the producer MUST set such a dependent's `effective-blocked="false"` and place it
in `<available>`, never in `<permanently-blocked>`. `permanently-blocked` is
reserved for a dependent whose blocking ancestor terminated *without* `verified`
and will not progress (a failed/abandoned ticket left parked).

Edges are carried as `<depends-on ticket="<id>"/>` children of the `<ticket>`
(the producer has already reasoned over them; the orchestrator reads them only
for surfacing context, never to re-derive blocking):

```xml
<ticket id="ENG-42" url="https://linear.app/acme/issue/ENG-42"
        role="available" group="unstarted" milestone="m1"
        effective-blocked="true" human-interactive="false" target-kind="pr"
        branch-seed="eng-42-token-refresh">
  <labels><label>backend</label></labels>
  <depends-on ticket="ENG-40"/>
</ticket>
```

### Derived sections

Computed by the producer across **all** projects. These are what the orchestrator
actually schedules from.

```xml
<available>
  <item ticket="ENG-40" rank="1" target-kind="pr"/>
  <item ticket="ENG-55" rank="2" target-kind="verification"/>
</available>
<blocked>
  <item ticket="ENG-42" reason="ancestor-unverified"  blocked-by="ENG-40"/>
  <item ticket="ENG-71" reason="milestone-gate"       milestone="m1"/>
</blocked>
<human-blocked>
  <item ticket="ENG-90" source="explicit-signal"/>
  <item ticket="ENG-91" source="worker-discovered"/>
</human-blocked>
<permanently-blocked>
  <item ticket="ENG-12" blocked-by="ENG-09" cause="ancestor-failed-parked"/>
</permanently-blocked>
<milestones>
  <milestone id="m1" project="P-1" ready-for-review="true"  review-recorded="false"/>
  <milestone id="m2" project="P-1" ready-for-review="false" review-recorded="false"/>
</milestones>
<counts>
  <project id="P-1" total="20" verified="11" canceled="1"
           permanently-blocked="0" remaining="8" terminal="false"/>
  <milestone id="m1" project="P-1" total="6" verified="6" canceled="0"
             permanently-blocked="0" remaining="0" terminal="true"/>
</counts>
<anomalies>
  <cycle><member ticket="ENG-30"/><member ticket="ENG-31"/></cycle>
  <reverse-dependency from="ENG-50" to="ENG-49"
                      from-project="P-2" to-project="P-1"/>
</anomalies>
```

Section semantics (§2.6 derived-sections table):

| Section                 | Element                            | Key fields                                                     | Used for                                                              |
| ----------------------- | ---------------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------- |
| `<available>`           | `<item>`                           | `ticket`, `rank` (ascending = highest priority), `target-kind` | Tick step 8 work fill — the ranked unblocked frontier                 |
| `<blocked>`             | `<item>`                           | `ticket`, `reason`, `blocked-by` / `milestone`                 | Surfacing only; expected to unblock as ancestors/gates resolve        |
| `<human-blocked>`       | `<item>`                           | `ticket`, `source` (`explicit-signal` \| `worker-discovered`)  | Tick step 6 — park + single alert; never dispatched                   |
| `<permanently-blocked>` | `<item>`                           | `ticket`, `blocked-by`, `cause`                                | Completion check (counts toward terminal); surfaced, never worked     |
| `<milestones>`          | `<milestone>`                      | `id`, `project`, `ready-for-review`, `review-recorded`         | Tick step 7 milestone-review gate                                     |
| `<counts>`              | `<project>` / `<milestone>`        | per-scope tallies + `terminal` rollup                          | Tick step 10 completion / termination                                 |
| `<anomalies>`           | `<cycle>` / `<reverse-dependency>` | members / endpoints                                            | MUST surface; MUST NOT silently work around (a cycle is illegal §2.3) |

**Pinned field semantics** (a producer MUST emit these exactly; the orchestrator
reads them and MUST NOT re-derive):

- `<counts>` rows (both `<project>` and `<milestone>`) carry the same field set:
  `total`, `verified`, `canceled`, `permanently-blocked`, `remaining`, and the
  `terminal` rollup. `remaining = total − verified − canceled − permanently-blocked`
  (the still-workable members). `terminal="true"` **iff** `remaining == 0` — i.e.
  every member is `verified`, `canceled`, or `permanently-blocked`. Project
  termination (tick step 10) is exactly `terminal="true"` on every selected
  `<project>`.
- `<blocked>` `reason` is a closed enum: `ancestor-unverified` (carries
  `blocked-by`) or `milestone-gate` (carries `milestone`).
- `<permanently-blocked>` `cause` is a closed enum: `ancestor-failed-parked` (a
  failed/abandoned ancestor left parked) or `ancestor-permanently-blocked` (the
  transitive cascade — an ancestor that is itself permanently-blocked). A plain
  `canceled` ancestor is **never** a cause: it unblocks its dependents per §2.3.

`available` ranks are produced by the producer; the orchestrator MUST NOT re-rank.
`review-recorded` is scoped to the milestone's **current** ready-for-review
episode, not a permanent flag: if a review files follow-up tickets into the
milestone, the milestone regains incomplete work, `ready-for-review` returns to
`false`, and on re-completion `review-recorded` MUST again be `false` until a
fresh review runs.

### Full-sync shape vs delta shape

A **full sync** (`mode="full"`, `since="-"`) emits the complete document: every
`<project>` with every `<ticket>`, and every derived section computed in full. It
is the fallback path — first run, recovery, a cursor gap, or a producer with no
delta support — and is what the durable cache MUST be reconstructible from.

A **delta** (`mode="delta"`, `since="<prior-cursor>"`) emits only what changed
since `since`, **plus** all derived sections refreshed in full (derived sections
are never partial — they are always replaced wholesale on merge):

- Changed/added nodes appear as ordinary `<ticket>` elements (full node state, not
  a patch) under their `<project>`. A node present in the delta replaces the
  cached node of the same `id`.
- A **removed** node (deleted from the tracker, or no longer in any selected
  project) is encoded as `<ticket id="..." removed="true"/>` — an explicit
  tombstone, not an omission. Omission means "unchanged," so removal MUST be
  explicit. The orchestrator drops the matching cached node on merge.
- A `<project>` with no changed tickets MAY be omitted entirely; a project that
  itself was removed is encoded `<project id="..." removed="true"/>`.
- All seven derived sections (`<available>` … `<anomalies>`) MUST be present in
  full on every delta, reflecting the producer's recompute across all projects.

The producer MUST still emit the current state of an **excluded** ticket (one the
orchestrator passed as in-flight / done / failed) on both full and delta — the
exclusion suppresses it from `<available>` only, never from node updates — so the
durable cache never goes stale for in-flight or terminal work.

```xml
<project-graph mode="delta" cursor="2026-06-08T14:03:11Z" since="2026-06-08T13:58:02Z">
  <project id="P-1" tracker="linear" name="Auth rework">
    <ticket id="ENG-40" url="https://linear.app/acme/issue/ENG-40"
            role="verified" group="completed"
            effective-blocked="false" human-interactive="false"
            target-kind="pr"/>
    <ticket id="ENG-42" url="https://linear.app/acme/issue/ENG-42"
            role="available" group="unstarted" milestone="m1"
            effective-blocked="false" human-interactive="false"
            target-kind="pr" branch-seed="eng-42-token-refresh">
      <depends-on ticket="ENG-40"/>
    </ticket>
    <ticket id="ENG-99" removed="true"/>
  </project>
  <available>
    <item ticket="ENG-42" rank="1" target-kind="pr"/>
  </available>
  <blocked/>
  <human-blocked/>
  <permanently-blocked/>
  <milestones>
    <milestone id="m1" project="P-1" ready-for-review="false" review-recorded="false"/>
  </milestones>
  <counts>
    <project id="P-1" total="20" verified="12" canceled="1"
             permanently-blocked="0" remaining="7" terminal="false"/>
  </counts>
  <anomalies/>
</project-graph>
```

Here ENG-40 just reached `verified`, which unblocked ENG-42 (now
`effective-blocked="false"` and ranked first in `<available>`); ENG-99 was
deleted and is tombstoned. The empty `<blocked/>`, `<human-blocked/>`,
`<permanently-blocked/>`, `<anomalies/>` are explicit empty sections — a present
but empty section means "nothing in this section," distinct from a section's
absence (which MUST NOT occur: all derived sections are always emitted).

## Slot ledger

A **slot** is the right to perform local **compute** — write code, install
dependencies, build, or run tests — on the shared host. `MAX_PARALLEL`
(implementation-defined) bounds how many agents may be in such a stage at once.
Slots are about local compute, **not** work-in-flight: a PR merely open and
awaiting CI/review/merge holds **no** slot.

### On-disk layout

A single shared ledger of exactly `MAX_PARALLEL` entries — the single source of
truth for the bound, drawn from by **every** agent that may compute
(coordinators and the §2.4 delivery workers they spawn alike):

```
<state-root>/orchestrate/slots/
  ledger.json            # the canonical ledger; mutated only under the lock below
  ledger.lock            # advisory lock for atomic acquire/release/reclaim
```

`ledger.json` holds `MAX_PARALLEL` entry rows; a free entry has a null owner:

```json
{
  "max_parallel": 4,
  "entries": [
    { "slot": 0, "owner": "coord:ENG-42",        "heartbeat": "2026-06-08T14:03:05Z" },
    { "slot": 1, "owner": "worker:acme__api#318", "heartbeat": "2026-06-08T14:03:09Z" },
    { "slot": 2, "owner": null, "heartbeat": null },
    { "slot": 3, "owner": null, "heartbeat": null }
  ]
}
```

- `owner` identifies the holding agent — a coordinator (`coord:<ticket-id>` or
  `coord:<repo>#<pr>` for a bare-PR coordinator) or a delivery worker
  (`worker:<repo>#<pr>`). A worker holds its **own** entry; a coordinator running
  several independent PRs holds one entry per concurrently-building worker, plus
  its own when it computes directly.
- `heartbeat` is an RFC 3339 timestamp the owner refreshes on a fixed interval
  while it holds the entry.

### Acquire / release / reclaim

- **Atomic acquire** — before entering any stage that may write code, install,
  build, or run tests, an agent takes `ledger.lock`, claims the first free entry
  (sets `owner` + `heartbeat`), and releases the lock. If no entry is free, it
  releases the lock, **waits**, and retries — it never exceeds the bound. This
  atomic acquire is the **binding** bound.
- **Release** — on leaving a compute stage for any wait (CI, review, merge, a
  human handoff, idle polling) or on exit, the owner takes the lock, nulls its
  entry, releases the lock. Because every wait releases the entry, nothing is
  permanently reserved: an agent parked on CI or a reviewer holds no entry, so a
  milestone-review agent or a freshly-unblocked ticket always finds capacity as
  in-flight work idles.
- **Reclaim** — the orchestrator's tick (step 3) takes the lock and nulls any
  entry whose `heartbeat` is older than the staleness threshold, so a crashed
  coordinator or worker cannot leak capacity. Terminal cleanup MUST NOT
  force-release a *live* worker's entry; entries are released only by their owner
  or by this stale-reclaim sweep.

### Soft admission vs atomic acquire

These are two distinct gates and MUST NOT be conflated:

- **Soft admission** (orchestrator, tick step 8) — the orchestrator caps *new
  coordinator dispatches this tick* at the number of free entries observed at the
  **start** of step 8. It does **not** pre-reserve those entries at dispatch. This
  is a coarse throttle that avoids spawning far more agents than the host can
  compute.
- **Atomic acquire** (every computing agent) — the hard, binding bound. Two
  coordinators admitted in the same tick still **serialize** at the ledger when
  they each reach a compute stage: whichever reaches the lock second waits if no
  entry is free. Admission bounds dispatch fan-out; acquire bounds actual concurrent
  compute.

## Dispatch to coordinators

When dispatching, the orchestrator passes only the data the unit needs to act; it
**never** passes ticket content. It dispatches exactly two kinds of unit.

### Ticket coordinator (§2.5)

Dispatched for every `pr` and `verification` ticket, and for each injected bare PR.
Inputs:

| Input                                   | When                         | Meaning                                                                  |
| --------------------------------------- | ---------------------------- | ------------------------------------------------------------------------ |
| `ticket_id`, `ticket_url`               | ticket-backed                | The §2.3 ticket the coordinator owns end-to-end                          |
| `repo`, `pr_number`, `pr_url`, `branch` | injected bare PR (no ticket) | The PR's forge identity, in place of a ticket id/url                     |
| `target-kind`                           | always                       | `pr` \| `verification` — the coordinator branches on this                |
| `branch-seed`                           | optional                     | Non-authoritative branch-name hint passed through from the node          |
| identity / mode context                 | always                       | §2.1 Mode A / Mode B context (identity attribution + human routing)      |
| §2.3 hook responsibilities              | always                       | The role transitions and DoD/verification artifacts the coordinator owns |

The coordinator owns **all** of its ticket's §2.3 transitions and
verification/DoD artifacts; the orchestrator performs no transitions itself. On a
terminal coordinator outcome the orchestrator does **cleanup only** — lock,
"working" label, worktree (if any), and the outcome artifact — and does NOT
force-release compute entries (the coordinator's workers already released theirs;
stragglers are reclaimed by the stale sweep).

### Milestone-review agent (§2.3, §2.6)

Dispatched for a milestone that is `ready-for-review` and not yet
`review-recorded`. Inputs: the **milestone identifier** and its **project** —
nothing more. It records the review outcome on the §2.3 review artifact and routes
any human-input request through that artifact's comments (§Milestone-review
routing). The orchestrator MUST NOT perform the review itself.

### Lock keys

Every dispatched unit maintains a heartbeated **lock**; staleness is judged by
lock age (tick step 3 clears stale locks and presumes the unit dead).

| Unit                         | Lock key        | Form                       |
| ---------------------------- | --------------- | -------------------------- |
| ticket coordinator (ticket)  | ticket-keyed    | `<ticket-id>`              |
| ticket coordinator (bare PR) | PR-keyed        | `<repo>#<pr_number>`       |
| milestone-review agent       | milestone-keyed | `<project>/<milestone-id>` |

A coordinator's §2.4 delivery workers hold their own **compute-slot** entries
(§Slot ledger), **not** separate orchestrator locks.

### Outcome-artifact vocabulary

Each dispatched unit writes one **outcome artifact** as its final action; the
orchestrator reads it to reconcile (tick step 4 for coordinators, step 5 for
review agents). The §2.5 coordinator outcomes, handled exhaustively:

| Outcome                                    | Orchestrator reconciliation (tick step 4)                                                                                 |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `verified`                                 | cleanup + drop (terminal; coordinator owns the §2.3 `verified` transition + DoD artifact)                                 |
| `canceled`                                 | cleanup + drop (terminal; a `canceled` ancestor unblocks its dependents on the next fetch)                                |
| `delivered`                                | cleanup + drop; a **separate** verification work item takes the ticket to `verified` (for a bare PR, `delivered` is done) |
| `human-blocked`                            | cleanup + drop; the parked ticket is then honored at tick step 6 (park + single alert)                                    |
| `decomposed`                               | cleanup; record the parent as a **deferred-finalization** entry — finalize once every subtask is `verified`/`canceled`    |
| `failed` (verification, `retryable=true`)  | **re-dispatch** on a later tick                                                                                           |
| `failed` (verification, `retryable=false`) | **park** (the verification gate stays blocked); surface to the operator; no re-dispatch                                   |
| `failed` (other)                           | cleanup + drop; surface to the operator; no auto-re-dispatch                                                              |

When **no outcome artifact** is present, reconcile by liveness: if the work item
is terminal (ticket at a terminal §2.3 role, or a bare PR merged/closed) →
cleanup + drop; elif no live owner (no / stale lock) → re-dispatch the same
coordinator; else (live owner) → nothing this tick.

A **milestone-review agent**'s outcome is the recorded-review signal: when the
review outcome is recorded the orchestrator cleans the milestone-keyed sentinel
(the gate opens and gated tickets unblock via the next fetch); else if no live
owner, re-dispatch; else nothing this tick.

A `decomposed` parent is tracked as a **deferred-finalization** entry in the
active set — neither `available` nor owned by a live unit, holding no slot — and a
finalizing coordinator is dispatched only once the graph reports every subtask
`verified`/`canceled`. This keeps an `in-progress` parent from being lost or
re-dispatched in a loop while its subtasks run.

## Milestone-review routing

Milestone review frequently needs human judgment. The venue is fixed by §2.3: the
milestone's **review artifact** is where a milestone review's outcome is recorded
and where any human input for it is solicited. By tracker:

| Tracker | Review artifact (routing venue)    |
| ------- | ---------------------------------- |
| Linear  | the milestone's **project update** |
| GitHub  | the **Milestone closure comment**  |
| Asana   | the **milestone-task comment**     |

The milestone-review agent MUST solicit any human input it needs as a **comment on
that same review artifact**, tagging a human — **never** through the session — and
MUST NOT record the review outcome until that input resolves. This keeps the
conversation in the tracker, consistent with the §2.3 communication restriction.

A team that wants a human to *own* the review outright can instead model the
milestone-review item as `human-interactive` (graph `human-interactive="true"`)
and let the §Human-interactive path handle it; the default is agent-run with
comment-routed human input.
