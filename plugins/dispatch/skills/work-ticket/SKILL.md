---
name: work-ticket
description: Coordinate one tracked work item to a terminal role — claim it, fetch its own brief, decompose if needed, drive its PR(s) to merge via deliver, keep its ticket role synced, and verify its aims. Use whenever the unit of work is a ticket (or a single injected PR), standalone (/work-ticket DEV-123) or dispatched by an orchestrator.
---

# work-ticket

Drive one **tracked work item** to a terminal role. The coordinator owns the
*ticket*: it delegates each code change to [`deliver`](../deliver/SKILL.md),
applies the role transitions, decomposes when needed, and decides when the
aims are **verified**. It does **not** own the PR lifecycle
(`deliver` does), the dependency graph, ranking, or dispatch (the orchestrator
does).

**Operator** = the human directing this run. **Delivery worker** = a `deliver`
instance, one per PR. Glossary and lookup tables: [`reference.md`](./reference.md).

Nothing below names a tracker. The roles, transitions, and ticket operations are
the protocol's; a **tracker adapter** binds them to whichever platform the ticket
lives on (next section). Your default tracker is `${user_config.tracker}`; the
operator is `${user_config.operator_login}`.

## Target kind & inputs

Branch on `target-kind`; the inputs decide it:

| kind           | inputs                                                              | path                                                          |
| -------------- | ------------------------------------------------------------------- | ------------------------------------------------------------- |
| `pr`           | `ticket_id` + `ticket_url`                                          | claim → brief → (decompose?) → PR(s) via `deliver` → verify   |
| `verification` | `ticket_id` + `ticket_url`                                          | claim → run named suite read-only vs deployed target → verify |
| bare PR        | forge identity (`repo`, `pr_number`, `pr_url`, `branch`), no ticket | drive the one PR to merge via `deliver`                       |

Resolve it authoritatively: **bare-PR vs ticket-backed** from the inputs (forge
identity vs ticket fields); **`pr` vs `verification`** from the dispatched
`target-kind` when dispatched, else (standalone) from the ticket — a
`verification` ticket names a suite + deployed target and needs no code change.
Hints (branch seed, scope, a standalone kind guess) are advisory; confirm them.

**Fetch the brief yourself — never require ticket content passed in.** For
ticket-backed work read the ticket's description, acceptance criteria, deps, and
links. You MAY read **one-edge** dependency neighbors (direct predecessors/
successors) read-only when it shapes delivery; never walk or reason over the graph.

## Tracker

Ticket-backed work runs through a **tracker adapter** — a skill named
`tracker-adapter-<id>`, the one place that knows a platform's state names and
tool calls. Load it before the first ticket read:

1. **Tracker id** — list the installed `tracker-adapter-*` skills and read each
   one's Identity section (don't assume the bundled set), then: the adapter
   whose *ticket URLs* shape matches the ticket's URL; failing that (a bare id,
   no URL) the adapter whose *ticket ids* shape matches; failing that
   `${user_config.tracker}`. A ticket URL no installed adapter claims names its
   own tracker — take the id from the URL, not from the default; it heads to
   step 3, not to the default adapter.
2. **Adapter skill** — read `tracker-adapter-<id>`. When several skills carry
   the same id — a repo or personal skill shadowing a bundled one — the most
   specific wins (repo, then personal, then plugin), wholesale: adapters
   replace, never merge.
3. **No adapter** — best effort: take the tracker from step 1 (the ticket
   URL, or `${user_config.tracker}` for a bare id), drive its native MCP
   server (or CLI) directly, and map its states and operations onto the
   protocol's roles and operation vocabulary yourself.
   Escalate to the operator rather than guess when a state's lifecycle meaning
   is ambiguous. An adapter, when present, always wins — it records the
   decisions best effort would have to make from scratch.

Every ticket read and write below is one of the adapter's **operations**: name
the operation, run its binding, and speak roles, never native states. Contract,
operation vocabulary, and the fallbacks for an operation an adapter marks
`unsupported`: [`reference.md`](./reference.md#tracker-adapters).

A **bare PR** has no ticket, hence no adapter — driven on the forge regardless
of the `tracker` config (see **Injected bare PR**).

## Standalone vs dispatched

Same rules; only the reporting surface differs. **Standalone** — a human runs
`/work-ticket <ID>`; also report the outcome to the session. **Dispatched** —
the orchestrator hands over the item with the claim agent id, any `pass`
(verify · finalize · retry — a re-dispatch scoped to that step;
[`reference.md`](./reference.md#dispatch-bookkeeping)), and identity/mode,
which you forward to every `deliver`. (Operator login is not forwarded — each
`deliver` reads it from the shared plugin config.)

In both modes you are bound by the **communication restriction**:
never solicit a session response or block on session input for progress; route
human input PR → ticket → new ticket, tagging a human (see **Human handoff**).
Progress, status, and summaries to the session are fine — but if proactive
session input substantively changes the work, echo its substance onto the ticket
or PR.

## Claim (ticket-backed only)

Idempotent, in order:

1. **Graph claim** — `dispatch graph claim --id <ID> --agent <agent-id>` (the
   dispatched claim id, or mint `wt-<epoch>` standalone). On `claimed` /
   `refreshed` / `reclaimed`, proceed. Otherwise
   ([details](./reference.md#graph-claim)):
   - `unknown-task` — the graph hasn't seen this ticket. Fetch its subgraph
     (the ticket + transitive blockers, per the reference), then retry once.
   - blocked — unresolved blockers. Standalone: work them first — apply this
     skill to each unresolved id in the ticket's `blocked-by` (from
     `dispatch graph doc`), depth-first, then re-claim. Dispatched: the graph
     moved under the dispatch; write `failed` (retryable) and stop.
   - `held` — another agent's live claim; stop.
   - any other classification (backlog, parked, terminal) — not claimable;
     report and stop (parked resumes only via **Human handoff**).

   `reclaimed` is a sanctioned takeover of a dead run — proceed even though the
   ticket is already `in-progress`, re-deriving its state from the ticket and
   PRs (a `pass=resume` dispatch is exactly this).
2. **Tracker claim** — (a) resolve the role; (b) if a `started` role is held by
   a *different* platform identity, stop — a reclaim covers a dead run under
   your own platform account, not someone else's work; (c) assign to self; (d)
   if not already
   `in-progress`, emit `available → in-progress` (state-change comment +
   `TRANSITION` log); if already `in-progress` as self (resume / re-dispatch
   after a stale claim), don't re-emit. Parked (`paused`/`awaiting-external`) →
   resume via `available` first, never straight to `in-progress`.

While you hold the claim, run `dispatch graph heartbeat` (same `--id`/`--agent`)
at least every few minutes (fold into poll ticks). The claim ends with your
outcome — `dispatch graph outcome set` releases it (see **Report**). Never run
a bare `release`: a released claim with no outcome reads as a crash and gets
re-dispatched.

## Decompose

- **Too large** → file native subtasks; parent stays `in-progress`; record each
  subtask as a `blocks` edge to the parent — on the tracker **and** in the
  graph (`dispatch graph task set` each subtask, then
  `dispatch graph edge add --blocker <subtask> --blocked <ID>`), so the
  finalize gate holds before the next refresh; log `INFO`; record `decomposed`;
  **stop**. You don't drive the subtasks' PRs or finalize the parent — both are a
  later, separate pass.
- **Out-of-scope blocker** → file a `blocks`-linked ticket; log `BLOCK`; then park
  the ticket (`awaiting-external`, or `paused` if unavailable) if all remaining work
  is blocked, else continue the in-scope work.

## Produce PRs (via `deliver`)

Drive each in-scope unit's PR to terminal through `deliver`. Invoke
`dispatch:deliver` inline (single PR) or as a subagent (concurrent PRs),
forwarding identity/mode. **Sequential by default** (one building PR at a
time); go concurrent only for independent work, one slot per building PR.
Record the ticket↔PR mapping on the ticket as each PR opens. Read a delegated
PR's status only via `deliver`.

## Sync the role

| ticket condition                                   | role          |
| -------------------------------------------------- | ------------- |
| claimed; implementation underway                   | `in-progress` |
| delegated to review; no implementation outstanding | `in-review`   |
| review approved; merge pending (adapter maps it)   | `finished`    |
| **every** PR required by the aims has landed       | `delivered`   |
| aims validated and DoD artifact posted             | `verified`    |

Intermediate merges are recorded, not promoted to `delivered`. No `finished`
where the adapter leaves it unmapped (collapse `in-review → delivered`).
Corrective transitions carry a rationale.
Emit no unenumerated transition; every change → a `TRANSITION` log **and** a
state-change comment on the primary venue.

## Definition of done

`verified` requires a ticket comment stating **what** was verified (vs the aims),
**how** (concrete method), and **what was not** (each deferred item with a
follow-up ticket filed). Merging ≠ done — evaluate the aims. Any in-scope
aim unverified → return to `in-progress` with a corrective comment; never edit or
delete the original artifact.

## Verification work (no PR)

Read the named conformance suite and deployed target; confirm it is reachable at
the expected revision; run the suite **read-only** (a verification never mutates —
a required mutation is a structural failure); attach the evidence; advance the
forward path to `verified` with the DoD artifact (the path collapses over roles
the adapter leaves unmapped; no unenumerated transition). Can't pass → `failed`
with `retryable` (transient cause = retryable; structural = not). Never
`verified` on failure.

## Injected bare PR (no ticket)

Inputs are the forge identity; the graph item is keyed `<repo>#<n>` —
dispatched, claim it like a ticket; standalone, create it first with
`dispatch graph pr add`. Nothing to decompose or transition on a tracker. Drive
the one PR via `deliver`; report `delivered` on merge (terminal — a ticketless
PR has no separate verification step), else `canceled`/`failed`. If the PR *is*
ticket-linked, act as that ticket's coordinator with the PR as one `deliver`
instance.

## Human handoff (worker-discovered)

When a human must act — a decision you can't make, a credential you lack, a manual
external step:

1. **Alert** via PR → ticket → new ticket, tagging ≥1 human, stating what's needed
   and why you can't proceed.
2. Transition to **`awaiting-external`** (or `paused`); if the adapter maps
   neither, `ERROR` — there is no valid park.
3. Log **`WAIT`** (name the venue + awaited outcome).
4. **Report** — dispatched: record the `human-blocked` outcome and exit;
   standalone: wait on the venue with thread-aware filtering.

Keep **≤1** open alert (scan the venue first). Resolution: on an addressable
human response, react, log `RESUME`, post a follow-up if substantive, then
resume from a **fresh claim** (parked → `available` → `in-progress`).

## Slots

A slot is the right to use **local compute** (write code, install, build,
test), taken from the shared ledger: `dispatch graph slot acquire --agent
<agent-id>` before a worker builds or a suite runs (one slot per concurrent
build, else sequence; exit 3 = full — wait and retry), `slot release` on any
wait (CI/review/merge/handoff/idle) or exit, `slot heartbeat` while computing.
The ledger is host-wide, so standalone runs share the same bound.

## Report

The outcome is one of `verified` · `canceled` · `delivered` · `human-blocked` ·
`decomposed` · `failed` — meaning, terminality, and how each resumes are in
[`reference.md`](./reference.md#outcomes). Record it as your **final action**:

```shell
dispatch graph outcome set --id <key> --agent <agent-id> --outcome <o> \
    [--retryable true|false] [--detail "one line"]
```

It releases your claim in the same write. Standalone, also report it to the
session.

## Log

Emit `TRANSITION` / `WAIT` / `RESUME` / `BLOCK` / `INFO` / `ERROR` one-liners, and
echo every role change as a state-change comment on the primary venue. Format and
fields: [`reference.md`](./reference.md#logging).
