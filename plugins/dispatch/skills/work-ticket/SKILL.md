---
name: work-ticket
description: Coordinate one tracked work item to a terminal §2.3 role — claim it, fetch its own brief, decompose if needed, drive its PR(s) to merge via deliver, keep its ticket role synced, and verify its aims. Use whenever the unit of work is a ticket (or a single injected PR), standalone (/work-ticket DEV-123) or dispatched by an orchestrator.
---

# work-ticket

Drive one **tracked work item** to a terminal §2.3 role. The coordinator owns the
*ticket*: it delegates each code change to [`deliver`](../deliver/SKILL.md) (§2.4),
applies the §2.3 role transitions, decomposes when needed, and decides when the
aims are **verified** — not merely merged. It does **not** own the PR lifecycle
(`deliver` does), the dependency graph, ranking, or dispatch (§2.6 orchestrator).

**Operator** = the human directing this run. **Delivery worker** = a `deliver`
instance, one per PR. Glossary and lookup tables: [`reference.md`](./reference.md).

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

For **ticket-backed** work the ticket's URL selects its tracker (a `linear.app`
ticket → Linear; a `github.com` issue → GitHub Issues); the `tracker` config
(default `linear`) is the fallback when the input is ambiguous — so a
Linear-by-default install still handles a project whose tickets live elsewhere.
**Only `linear` is implemented today**; a ticket on an unimplemented tracker →
`ERROR` and stop. A **bare PR** has no ticket and no tracker to resolve — it is
driven on the forge (GitHub) via `deliver` regardless. The body speaks §2.3 roles;
the per-tracker mapping is in `reference.md`.

## Standalone vs dispatched

Same rules; only the reporting surface differs. **Standalone** — a human runs
`/work-ticket <ID>`; report the outcome to the session. **Dispatched** — the §2.6
orchestrator hands over the item and expects an outcome artifact + heartbeated lock
([`reference.md`](./reference.md#dispatch-artifacts)), and passes identity/mode +
operator login, which you forward to every `deliver`.

Assigned for the run, you are bound by the §2.3 **communication restriction**:
never solicit a session response or block on session input for progress; route
human input PR → ticket → new ticket, tagging a human (§Human handoff). Progress,
status, and summaries to the session are fine — but if proactive session input
substantively changes the work, echo its substance onto the ticket or PR.

## Claim (ticket-backed only)

Idempotent. (1) Resolve the role. (2) If a `started` role is held by a *different*
identity, stop. (3) Assign to self. (4) If not already `in-progress`, emit
`available → in-progress` (state-change comment + `TRANSITION` log); if already
`in-progress` as self (resume / re-dispatch after a stale lock), don't re-emit.
Parked (`paused`/`awaiting-external`) → resume via `available` first, never
straight to `in-progress`.

## Decompose (§2.3)

- **Too large** → file native subtasks; parent stays `in-progress`; record each
  subtask as a `blocks` edge to the parent; log `INFO`; emit `decomposed`;
  **stop**. You don't drive the subtasks' PRs or finalize the parent — both are a
  later, separate pass.
- **Out-of-scope blocker** → file a `blocks`-linked ticket; log `BLOCK`; then park
  the ticket (`awaiting-external`, or `paused` if unavailable) if all remaining work
  is blocked, else continue the in-scope work.

## Produce PRs (§2.4 via `deliver`)

Drive each in-scope unit's PR to terminal through `deliver` — one §2.4 instance
each. Invoke `dispatch:deliver` inline (single PR) or as a subagent (concurrent
PRs), forwarding operator login + identity/mode. **Sequential by default** (one
building PR at a time, keeping PRs small and the ledger draw minimal); go
concurrent only for independent work, one slot per building PR. Record the
ticket↔PR mapping on the ticket as each PR opens. Read a delegated PR's status only
via §2.4/§2.2.

## Sync the role (§2.3)

| ticket condition                                   | role          |
| -------------------------------------------------- | ------------- |
| claimed; implementation underway                   | `in-progress` |
| delegated to review; no implementation outstanding | `in-review`   |
| **every** PR required by the aims has landed       | `delivered`   |
| aims validated and DoD artifact posted             | `verified`    |

Never `delivered` until **all** required PRs land (intermediate merges are
recorded, not promoted). No `finished` where the tracker lacks it (collapse
`in-review → delivered`). Corrective transitions carry a rationale. Emit no
unenumerated transition; every change → a `TRANSITION` log **and** a state-change
comment on the primary venue.

## Definition of done

`verified` requires a ticket comment stating **what** was verified (vs the aims),
**how** (concrete method), and **what was not** (each deferred item with a
follow-up ticket filed), per §2.1. Merging ≠ done — evaluate the aims. Any in-scope
aim unverified → return to `in-progress` with a corrective comment; never edit or
delete the original artifact.

## Verification work (no PR)

Read the named conformance suite and deployed target; confirm it is reachable at
the expected revision; run the suite **read-only** (a verification never mutates —
a required mutation is a structural failure); attach the evidence; advance the
§2.3 forward path to `verified` with the DoD artifact (the path collapses where the
tracker lacks roles; no unenumerated transition). Can't pass → `failed` with
`retryable` (transient cause = retryable; structural = not). Never `verified` on
failure.

## Injected bare PR (no ticket)

Inputs are the forge identity; nothing to claim, decompose, or transition. Drive
the one PR via `deliver`; report `delivered` on merge (terminal — a ticketless PR
has no separate verification step), else `canceled`/`failed`. Lock is **PR-keyed**.
If the PR *is* ticket-linked, act as that ticket's coordinator with the PR as one
§2.4 instance.

## Human handoff (worker-discovered)

When a human must act — a decision you can't make, a credential you lack, a manual
external step:

1. **Alert** via PR → ticket → new ticket, tagging ≥1 human, stating what's needed
   and why you can't proceed (§2.1).
2. Transition to **`awaiting-external`** (or `paused`); if the tracker maps
   neither, `ERROR` — there is no valid park.
3. Log **`WAIT`** (name the venue + awaited outcome).
4. **Release** — dispatched: write the `human-blocked` outcome and exit; standalone:
   wait on the venue per §2.1 thread-aware filtering.

Keep **≤1** open alert (scan the venue first). Resolution (§2.3): on an addressable
human response, react per §2.1, log `RESUME`, post a follow-up if substantive, then
resume from a **fresh claim** (parked → `available` → `in-progress`).

## Slot seam (§2.6)

A slot is the right to use **local compute** (write code, install, build, test).
§2.6 requires the delivery worker — and this coordinator while it runs a
verification suite — to hold a ledger entry while computing and release it for any
wait. The ledger is the orchestrator's; **standalone there is none**, so
acquire/release are no-op seams at the mandated points: acquire before a worker
builds or a suite runs (one entry per concurrent build, else sequence), release on
any wait (CI/review/merge/handoff/idle) or exit.

## Report

The outcome is one of `verified` · `canceled` · `delivered` · `human-blocked` ·
`decomposed` · `failed` — meaning, terminality, and how each resumes are in
[`reference.md`](./reference.md#outcomes-25). Dispatched: write the outcome artifact
as your **final action**, honoring the lock until then. Standalone: report it to
the session.

## Log (§2.3)

Emit `TRANSITION` / `WAIT` / `RESUME` / `BLOCK` / `INFO` / `ERROR` one-liners, and
echo every role change as a state-change comment on the primary venue. Format and
fields: [`reference.md`](./reference.md#logging-23).

## Config

From the plugin's `userConfig`, shared with `deliver`. Read the values this
skill needs as `${user_config.<key>}`, substituted into this skill at load time
— the resolved value is right there in the text. Do **not** read
`CLAUDE_PLUGIN_OPTION_*` from the environment: those are exported only to
hook/MCP subprocesses, never to this agent's Bash calls.

This skill only needs `operator_login` and `tracker` directly; the rest are read
by `deliver` from the same shared plugin config when you delegate a code change
— you don't forward their values.

| key                 | effect                                                                                                     |
| ------------------- | ---------------------------------------------------------------------------------------------------------- |
| `operator_login`    | operator's GitHub login (`${user_config.operator_login}`); used for §2.1 routing. Required.                |
| `tracker`           | **default** tracker (`${user_config.tracker}`); the per-item tracker is resolved from its URL/identity (§Tracker). |
| `worktree_base`     | read by `deliver` (per-PR worktrees). Default `~/.worktrees`.                                              |
| `team_mode`         | read by `deliver` (review shape). Default `false`.                                                         |
| `copilot_available` | read by `deliver`. Default `true`.                                                                         |

See [`reference.md`](./reference.md) for the role mapping, tracker operations, §2.1
recap, dispatch-artifact shapes, and log format. The spec (§2.1/§2.3/§2.4/§2.5/§2.6)
is authoritative where they differ.
