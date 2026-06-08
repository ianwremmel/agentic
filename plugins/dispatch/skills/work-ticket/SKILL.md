---
name: work-ticket
description: Coordinate one tracked work item to a terminal §2.3 role — claim it, fetch its own brief, decompose if needed, drive its PR(s) to merge via deliver, keep its ticket role synced, and verify its aims. Use whenever the unit of work is a ticket (or a single injected PR), standalone (/work-ticket DEV-123) or dispatched by an orchestrator.
---

# work-ticket

Coordinate a **single tracked work item** to a terminal §2.3 role. The
coordinator is the bridge between the ticket (§2.3) and the change (§2.4): it owns
the *ticket*, delegates each unit of code change to the [`deliver`](../deliver/SKILL.md)
skill (§2.4 Delivery), applies the §2.3 role transitions as those PRs progress,
decomposes the ticket when it is too large or blocked, and decides when the
ticket's stated aims are actually **verified** — not merely when a PR merged.

**Operator** = the one human directing this run; the only human with stop
authority. **Coordinator** = this skill. **Delivery worker** = a `deliver`
instance this skill drives, one per PR. Full role glossary and the lookup tables
this skill leans on are in [`reference.md`](./reference.md).

This skill does **not** own the PR lifecycle (`deliver` does), the dependency
graph, ranking, the global slot policy, or dispatch (the §2.6 orchestrator does).
It owns exactly one work item.

## Target kind

Every run branches on the work item's **target-kind**:

| target-kind    | Inputs                                                                   | Path                                                                    |
| -------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| `pr`           | `ticket_id` + `ticket_url`                                               | Claim → brief → (decompose?) → drive PR(s) via `deliver` → verify       |
| `verification` | `ticket_id` + `ticket_url`                                               | Claim → run named suite read-only vs deployed target → verify           |
| bare PR        | forge identity (`repo`, `pr_number`, `pr_url`, `branch`) — **no** ticket | Drive the one PR to merge via `deliver` (no claim/decompose/transition) |

**Resolving target-kind authoritatively:**

1. **Bare PR vs ticket-backed** comes from the *inputs themselves* — forge identity
   and no ticket fields ⇒ bare PR; `ticket_id` + `ticket_url` ⇒ ticket-backed.
2. **`pr` vs `verification`** (ticket-backed only): **dispatched**, it is the
   authoritative `target-kind` the §2.6 orchestrator passes in. **Standalone**,
   infer it from the ticket's own content after fetching the brief — a
   `verification` ticket names a conformance suite and a deployed target and
   mandates **no** code change; anything requiring an implementation is `pr`.

A caller MAY add non-authoritative **hints** (a branch-name seed, a commit scope,
a standalone `target-kind` guess). Hints are advisory: the coordinator MUST confirm
any hinted `target-kind` against the resolution above and the fetched ticket, and
the authoritative dispatched `target-kind` (step 2) is **not** a hint.

## Inputs and brief

**Never require ticket content to be passed in.** The caller hands the coordinator
only an *identifier and URL* (or, for a bare PR, the forge identity). For
ticket-backed work (`pr` / `verification`) the coordinator MUST fetch the ticket's
description, acceptance criteria, dependencies, and links itself (Linear MCP per
[`reference.md` §Tracker operations](./reference.md#tracker-operations)).

The coordinator MAY additionally read **read-only** context from its **immediate**
dependency neighbors — direct predecessors (what shipped just before) and direct
successors (what is planned next), **one edge away** — when that shapes how it
delivers. It MUST NOT walk or reason over the transitive graph (ranking, blocking,
and dispatch are the orchestrator's job).

## Standalone vs dispatched

Identical coordination rules; only the **reporting surface** differs (§Reporting).

- **Standalone** — a human runs `/work-ticket <TICKET-ID>` (or hands a bare-PR
  identity). No orchestrator, no liveness artifacts. The coordinator claims the
  item, drives it as far toward a terminal §2.3 role as it can, and reports its
  outcome **to the session** — which MAY be a non-terminal resting state
  (`decomposed`, `human-blocked`, `failed`) that a later run picks up (§Reporting).
- **Dispatched** — the §2.6 orchestrator hands over a work item and expects a
  terminal **outcome artifact** plus a **heartbeated lock** ([`reference.md`
  §Dispatch artifacts](./reference.md#dispatch-artifacts)). The orchestrator also
  passes the identity/mode context and the operator login, which the coordinator
  forwards to every `deliver` instance.

## Communication restriction (§2.3)

The coordinator is **explicitly assigned** its work item for the life of the run,
so the §2.3 communication restriction binds it: it MUST NOT solicit a session-level
response or block on session input for forward progress. All requests for human
input route through the venue order **PR → ticket → new ticket** (§Human handoff),
tagging a human, per §2.1. Emitting progress, status logs, and a final summary to
the session is permitted (that is how a standalone run "reports"). If proactive
user input arrives in the session and substantively changes the work, echo its
substance as a comment on the ticket or PR.

## Claiming (ticket-backed only)

A bare-PR run has no ticket and **skips this section**. Before any work on a
ticket the coordinator MUST claim it idempotently:

1. Resolve the ticket's current §2.3 role ([`reference.md` §Role mapping](./reference.md#linear--23-role-mapping)).
2. If the ticket is in a `started` role assigned to a **different** agent
   identity, **do not proceed** (§2.3 multi-agent coordination) — report and stop.
3. Assign the ticket to this coordinator's own agent identity.
4. Transition to `in-progress` **only if not already there**: from `available`,
   emit `available → in-progress` with its state-change comment and `TRANSITION`
   log. If already `in-progress` assigned to this identity (re-dispatch after a
   stale lock, or a resumed run), proceed **without** re-emitting — the claim is
   idempotent.

If the ticket is **parked** (`paused`, `awaiting-external`), first observe the
§2.3 resume rule: parked → `available` → `in-progress`. Never resume directly into
`in-progress`.

## Decomposition (§2.3)

Decide before producing any PR whether the ticket must be decomposed.

- **Too large** — file subtasks via the tracker's native subtask mechanism. The
  parent stays `in-progress`; each subtask is an independent unit handled by its
  **own** later coordinator run — this coordinator does **not** drive the
  subtasks' PRs. Record **each subtask as a `blocks` edge to the parent** (so the
  parent is effectively blocked by its subtasks), log subtask creation as `INFO`,
  emit the **`decomposed`** outcome, and **stop**. Parent finalization (verifying
  its aims once subtasks land, then advancing it to `verified`) is a **separate,
  later** coordinator pass — not part of this run.
- **Out-of-scope blocker** — file a new ticket for the blocker, link it as a
  `blocks` edge to the current ticket, log a `BLOCK` entry. Then either **park**
  the current ticket (`awaiting-external`, or `paused` if unavailable) if all
  remaining work is blocked, or **continue** the in-scope work if independent work
  remains.

## PR production (§2.4 via `deliver`)

For each **in-scope unit of work**, drive a pull request to a terminal state
through the `deliver` skill — each PR is a distinct §2.4 Delivery instance.

- **How to invoke.** Translate the ticket's aims into a change description and run
  `deliver` on it: invoke `dispatch:deliver` **inline** for single-PR work (it
  holds the turn through the PR's whole lifecycle and returns its terminal
  outcome), or **dispatch it as a subagent** (one per PR) when running PRs
  concurrently. Forward the operator login and identity/mode context.
- **Sequential by default.** Run **at most one actively building PR at a time** —
  small PRs review faster and keep the draw on the shared compute-slot ledger
  minimal. Run PRs concurrently only when the work is genuinely independent,
  taking **one slot per concurrently-building PR** (§Slot seam).
- **Record the mapping.** As soon as each PR is opened, record the ticket↔PR
  mapping on the ticket (a progress comment per the tracker's convention) so an
  observer can see which PRs satisfy the ticket.
- **Status only through §2.4/§2.2.** The coordinator MUST NOT read the status of a
  delegated PR through any path other than what `deliver` / `pr-status` report for
  it.

## Role transitions (§2.3)

Keep the ticket's §2.3 role synchronized with the **aggregate** state of its PRs:

| Ticket condition                                        | Target role   |
| ------------------------------------------------------- | ------------- |
| Claimed; implementation underway                        | `in-progress` |
| Work delegated to review; no implementation outstanding | `in-review`   |
| **Every** PR required to satisfy the aims has landed    | `delivered`   |
| Aims validated and the §2.3 DoD artifact posted         | `verified`    |

The coordinator MUST NOT transition to `delivered` until **all** PRs needed to
satisfy the ticket's aims are merged or deployed (§2.3 multi-PR rule). An
intermediate PR merge is recorded but MUST NOT trigger `delivered`. On trackers
without `finished`, collapse `in-review → delivered` and never emit `finished`
(§2.3 graceful degradation). Corrective transitions (e.g. review surfaced new work
→ `in-review → in-progress`) follow §2.3 and MUST carry a rationale. Emit no
unenumerated transition.

Every role change emits a `TRANSITION` log line **and** a §2.3 state-change
comment on the primary venue ([`reference.md` §Logging](./reference.md#logging-23)).

## Definition of done

Transition into `verified` MUST be accompanied by a ticket comment recording all
three: **what** was verified (against the ticket's aims), **how** (the concrete
method — the green build URL, the request exercised, the rendered output), and
**what was not** (each deferred item with a follow-up ticket already filed). The
comment follows §2.1 (machine marker; Mode B sparkle wrapper).

Merging a PR is **never sufficient on its own** — evaluate the ticket's stated
aims. If **any** in-scope aim is unverified, do **not** transition to `verified`;
return the ticket to `in-progress` with a corrective-transition comment per §2.3.
The original verification artifact comment is never deleted or modified.

## Verification work (`target-kind: verification`)

A no-PR ticket. The coordinator produces no PR; instead it:

1. Reads the ticket to identify the **named conformance suite** and the **deployed
   target** to validate (a live release, an ephemeral preview, etc.).
2. Confirms the target is reachable and at the expected revision, then runs the
   suite **read-only** against it (acquire a slot only while running — §Slot
   seam). A verification **never mutates** the target; if passing would require a
   mutation, that is a structural (non-retryable) failure.
3. Attaches the evidence to the ticket per §2.1/§2.3 (what ran, where, the result).
4. Advances the ticket along the §2.3 **forward path** to `verified` — the running
   suite is its `in-review`/`delivered` work, a passing suite its delivery — and
   records the §Definition-of-done artifact at `verified`. With no PR the path
   collapses onto whatever roles the tracker provides (§2.3 graceful degradation);
   emit no unenumerated transition.

A verification that cannot pass reports a **`failed`** outcome carrying a
**`retryable`** flag: *retryable* for a transient cause (target not yet at the
expected revision, image still building, flaky infra — safe to re-run) or
*non-retryable* for a structural cause (acceptance unmet in a way a re-run cannot
fix — needs a follow-up ticket and/or human action). Never transition a failed
verification to `verified`.

## Injected bare PR (no ticket)

Inputs are the PR's forge identity (`repo`, `pr_number`, `pr_url`, `branch`).
There is nothing to claim, decompose, or transition: drive the **one** PR to a
terminal state through `deliver` and report a PR-terminal outcome — **`delivered`**
when it merges (terminal here; a ticketless PR has no separate verification step)
or **`canceled`**/**`failed`** when it closes without merging. Its liveness lock is
**PR-keyed** ([`reference.md` §Dispatch artifacts](./reference.md#dispatch-artifacts)).

If the injected PR **is** linked to a ticket, behave as a normal ticket
coordinator for that ticket (claim it, own its §2.3 transitions) with this PR as
one of its §2.4 Delivery instances.

## Human handoff (worker-discovered)

When the coordinator determines the ticket cannot proceed without a **human**
acting — a decision it cannot make autonomously, a credential it does not hold, a
manual step in an external system — it MUST:

1. **Alert** through the §2.3 routing rule (PR if one exists, else the ticket,
   else open a new ticket), tagging **at least one human**, per §2.1. The alert
   states what is needed and why the agent cannot proceed.
2. Transition the ticket to **`awaiting-external`** (or `paused` if the tracker
   lacks it), emitting the state-change comment. If the tracker maps **neither**
   parked role (even via a team override), surface an `ERROR` rather than emit an
   unenumerated transition — there is no valid park.
3. Emit a **`WAIT`** log entry naming the awaited venue and outcome.
4. **Release.** Dispatched: write the `human-blocked` outcome artifact and exit
   (the orchestrator re-dispatches a fresh claim once the human resolves it).
   Standalone: enter the §2.3 wait state on the chosen venue and monitor it per
   §2.1 thread-aware filtering.

Never block a session on input as a condition of forward progress. Ensure **no
more than one** outstanding human alert exists for the ticket at a time (scan the
venue for an existing unresolved alert before posting). **Resolution follows §2.3**:
when a human responds with addressable content, the coordinator MUST react per §2.1
(terminal reaction or text token), emit a `RESUME` log entry, post a follow-up
comment summarizing the action if the response was substantive, then resume the
work from a **fresh claim** (parked → `available` → `in-progress`) — a `TRANSITION`
log entry accompanies any role change. A standalone run does this resumption
itself; a dispatched run is re-dispatched fresh by the orchestrator and performs
the same resumption on its next invocation.

## Slot seam (§2.6 compute-slot ledger)

A **slot** is the right to use **local compute** — write code, install, build, run
tests. §2.6 requires every agent that may compute (the **delivery worker** while it
builds, and this coordinator only while it runs a **verification suite**) to hold a
ledger entry for the duration of that compute, and to release it for any wait. A PR
merely open and awaiting CI, review, or merge holds **no** slot.

That ledger is a **single shared on-disk structure the §2.6 orchestrator owns**.
Standalone there **is no orchestrator and so no ledger** — there is nothing to
acquire and a single coordinator cannot exceed a `MAX_PARALLEL` bound that does not
exist, so the acquire/release calls are present **as a seam** (no-ops today) at
exactly the points §2.6 makes them mandatory, letting the orchestrator wire the
real shared ledger in with no refactor:

- **Acquire** before entering a compute stage: before a delivery worker starts
  building a PR, and before running a verification suite. When running PRs
  concurrently, acquire **one entry per concurrently-building PR**; when none is
  free, **sequence** (this is why PRs run sequentially by default).
- **Release** on leaving compute for any wait (CI, review, merge, a human handoff,
  idle polling) or on exit.

The ledger itself (`MAX_PARALLEL`, reclamation of stale entries) is the
orchestrator's shared infrastructure and is **out of scope** for this skill —
see §2.6 §Slot accounting.

## Reporting

The outcome is one of (full semantics in [`reference.md` §Outcomes](./reference.md#outcomes-25)):

| Outcome         | Meaning                                                                                                   | Terminal?                 |
| --------------- | --------------------------------------------------------------------------------------------------------- | ------------------------- |
| `verified`      | Ticket-backed: aims validated and the §2.3 DoD artifact posted; ticket at `verified`.                     | yes                       |
| `canceled`      | Work abandoned (ticket canceled with rationale, or a bare PR closed without merging).                     | yes                       |
| `delivered`     | The change landed. Ticket-backed: all required PRs merged, verification owned elsewhere. Bare PR: merged. | ticket: no / bare PR: yes |
| `human-blocked` | Parked in `awaiting-external` pending a human; one alert posted.                                          | no                        |
| `decomposed`    | Split into subtasks; parent stays `in-progress`, blocked by the subtasks.                                 | no                        |
| `failed`        | Could not complete; reason recorded. Verification failures carry a `retryable` flag.                      | no                        |

- **Dispatched** — as the **final action**, write the outcome artifact and stop
  honoring liveness (the lock) per [`reference.md` §Dispatch artifacts](./reference.md#dispatch-artifacts).
- **Standalone** — no artifact obligation; report the same outcome to the session
  and stop.

## Logging (§2.3)

Emit §2.3 operational one-liners for every role transition (`TRANSITION`), wait
(`WAIT`/`RESUME`), out-of-scope blocker (`BLOCK`), and substantive non-state event
(`INFO`); emit `ERROR` for tracker errors and verification failures. Every
state-change transition is **also** echoed as a §2.3 state-change comment on the
primary venue. Line format and field rules: [`reference.md` §Logging](./reference.md#logging-23).

## Configuration

Read from the plugin's `userConfig` (env: `CLAUDE_PLUGIN_OPTION_*`), shared with
`deliver`:

| Key                 | Effect                                                                                                           |
| ------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `operator_login`    | GitHub login of the operator. Forwarded to every `deliver` instance and used for §2.1 routing. Required.         |
| `tracker`           | Work-item tracker. Default `linear`. The skill body speaks §2.3 roles; the tracker seam lives in `reference.md`. |
| `worktree_base`     | Forwarded to `deliver` for per-PR worktrees. Default `~/.worktrees`.                                             |
| `team_mode`         | Forwarded to `deliver`; selects its private/public review shape. Default `false`.                                |
| `copilot_available` | Forwarded to `deliver`. Default `true`.                                                                          |

The plugin's `userConfig` schema cannot constrain a string to an allowed set, so
the coordinator MUST validate `tracker` itself at startup: if its value is not a
tracker this skill implements (today only `linear`), surface an `ERROR` and stop
rather than proceeding — a clear, early failure instead of a deep runtime one.

## References

[`reference.md`](./reference.md) bundles the lookup tables this skill leans on —
the Linear↔§2.3 role mapping and per-operation tracker realizations, the §2.1
mode/marker/terminal-signal recap, the §2.6 dispatch-artifact shapes, the §2.5
outcome semantics, and the §2.3 log-line format — so the skill is self-contained
once installed. It points back to the full spec (§2.1, §2.3, §2.4, §2.5, §2.6)
where the two differ; the spec is authoritative.
