# §2.5.2 — Ticket Coordination Protocol: Normative

## Applicability

This protocol applies to any agent responsible for driving a **single tracked
work item** to a terminal §2.3 role. The agent is a **coordinator**, and the work
item is one of:

- an ordinary **ticket**, driven to terminal by producing and landing the pull
  request(s) its aims require — usually one, sometimes several, occasionally none
  (when the ticket is decomposed, handed to a human, or canceled before any
  implementation begins);
- a **no-PR verification** ticket, validated against a deployed target with no
  code change (§Verification work); or
- a **single injected PR** the orchestrator handed over, driven to merge via §2.4
  with no decomposition.

The coordinator branches on the work item's `target-kind`. Because the
orchestrator (§2.6) routes every kind through a coordinator, the coordinator — not
the orchestrator — owns the kind-specific behavior.

A coordinator MAY be invoked standalone (a human names one ticket) or dispatched
by an orchestrator (§2.6). The rules below are identical in both contexts; only
the reporting surface (§Reporting) differs.

A coordinator is explicitly assigned a tracked work item and is therefore subject
to the §2.3 communication restriction for the life of its assignment.

The ticket may live on any tracker supported by §2.3. Reads and writes to the
tracker follow §2.1 mode rules; the access mechanism (API, CLI, MCP) is
implementation-defined and orthogonal to the §2.1 mode.

## Inputs

A coordinator's required inputs depend on the work item's kind (a discriminated
union):

- **Ticket-backed work** (`pr` or `verification`): `ticket_id` and `ticket_url`.
- **Ticketless injected PR**: the PR's forge identity — `repo`, `pr_number`,
  `pr_url`, `branch` — and no ticket fields (§Injected bare PR).

A caller MAY additionally supply non-authoritative hints (a branch-name seed, a
`target-kind` hint, a commit scope). A coordinator MUST NOT require any ticket
*content* to be passed in. For ticket-backed work it MUST fetch the ticket's
description, acceptance criteria, dependencies, and links itself.

A coordinator MAY also read **read-only** context from its **immediate** dependency
neighbors — its direct predecessors (what shipped just before) and direct
successors (what is planned next), one dependency edge away — when that context
shapes how it delivers. It MUST NOT walk the transitive graph or reason over it
(ranking, blocking, and dispatch are the orchestrator's, §2.6); its read stays
bounded to those one-edge neighbors.

## Claiming

Claiming applies when the work item is a ticket. A coordinator for a **ticketless
injected PR** has no ticket to claim — it skips this section entirely (see
§Injected bare PR). Before doing any work on a ticket the coordinator MUST claim
it:

1. Resolve the ticket's current §2.3 role.
2. If the ticket is already in a `started` role assigned to a *different* agent
   identity, the coordinator MUST NOT proceed (§2.3 multi-agent coordination).
3. Assign the ticket to the coordinator's own agent identity.
4. Transition the ticket to `in-progress` per §2.3 **only if it is not already
   there**: from `available`, emit the `available → in-progress` transition with
   its state-change comment and `TRANSITION` log entry. If the ticket is already
   `in-progress` assigned to this identity — a re-dispatch after a stale/dead lock,
   or a resumed run — the coordinator proceeds **without** re-emitting the
   transition; the claim is idempotent.

If the ticket is in a parked role (`paused`, `awaiting-external`), the
coordinator MUST first observe the §2.3 resume rule (parked → `available` →
`in-progress`); it MUST NOT resume directly into `in-progress`.

## Decomposition

The coordinator MUST apply the §2.3 decomposition rule:

- **Too large** — file subtasks via the tracker's native subtask mechanism. Each
  subtask is then handled as an independent unit by its own coordinator run (per
  the paragraph below); this coordinator does not drive them itself. The parent
  ticket remains `in-progress` until all subtasks reach `verified` or `canceled`.
  Log the subtask creation as `INFO`.
- **Out-of-scope blocker** — file a new ticket for the blocker, link it as a
  `blocks` edge to the current ticket, and log a `BLOCK` entry. The coordinator
  then either parks the current ticket (`awaiting-external`, or `paused` if
  unavailable) or, if other in-scope work remains, continues it while the blocker
  is handled elsewhere.

A coordinator that files subtasks acts as the coordinator of the parent and MUST
NOT itself drive the subtasks' PRs; each subtask is an independent unit a separate
coordinator dispatch (or a later standalone invocation) handles. How the subtasks
get dispatched is the caller's concern (the orchestrator picks them up off the
graph; a standalone coordinator reports them and stops).

Because the parent stays `in-progress` while its subtasks run (§2.3), its
**finalization** — verifying the parent's aims once the subtasks land, then
advancing it along the §2.3 forward path to `verified` (or `canceled`) without
emitting any unenumerated transition — is a later, separate coordinator pass, not
part of this run. The decomposing coordinator MUST record each subtask
as a `blocks` edge to the parent (§2.3 §Dependencies) so the parent is effectively
blocked by its subtasks, emit a `decomposed` outcome (§Reporting), and stop. Under
an orchestrator the parent's finalization is scheduled per §2.6 (it re-enters work
once every subtask is `verified`/`canceled`); a standalone coordinator reports the
open subtasks and the pending parent finalization to the session.

## PR production

For each in-scope unit of work, the coordinator MUST drive a pull request to a
terminal state through the Delivery Protocol (§2.4). Each PR is a distinct §2.4
Delivery instance.

- The coordinator SHOULD run its PRs **sequentially** — at most one actively
  building PR at a time — to keep PRs small and its draw on the shared compute-slot
  ledger (§2.6 §Slot accounting) minimal.
- Each delivery worker MUST hold a compute-slot ledger entry while it may write
  code, install, build, or run tests, and MUST release it while its PR awaits CI,
  review, or merge. A coordinator MAY run PRs concurrently when the work is
  genuinely independent, acquiring one ledger entry per concurrently-building PR;
  when no entry is free it MUST sequence.
- The coordinator MUST record the ticket↔PR mapping on the ticket (a progress
  entry per the tracker's convention) so an observer can see which PRs satisfy
  the ticket.

The coordinator MUST NOT itself read PR status through any path other than §2.4 /
§2.2 for a PR it has delegated to a Delivery instance.

## Role transitions

The coordinator owns the ticket's §2.3 role and MUST keep it synchronized with
the aggregate state of the ticket's PRs:

| Ticket condition                                                   | Target role (§2.3) |
| ------------------------------------------------------------------ | ------------------ |
| Claimed; implementation underway                                   | `in-progress`      |
| Work delegated to review; no implementation outstanding            | `in-review`        |
| Every PR required to satisfy the ticket's aims has landed          | `delivered`        |
| Aims validated against the ticket and the §2.3 DoD artifact posted | `verified`         |

The coordinator MUST NOT transition the ticket to `delivered` until **all** PRs
needed to satisfy its aims are merged or deployed (§2.3 multi-PR rule). An
intermediate PR merge is recorded but MUST NOT trigger `delivered`.

Corrective transitions (e.g. review surfaced new work → `in-review →
in-progress`) follow §2.3 and MUST carry a rationale.

## Definition of done

Transition into `verified` MUST follow §2.3 in full: it MUST be accompanied by a
ticket comment recording **what** was verified (against the ticket's aims),
**how** it was verified (the concrete method), and **what was not** verified
(each deferred item with a follow-up ticket already filed). If any in-scope aim
is unverified, the coordinator MUST NOT transition to `verified`; it returns the
ticket to `in-progress` with a corrective-transition comment per §2.3.

Merging a PR is never sufficient on its own. The coordinator evaluates the
ticket's stated aims, not merely the merge.

## Verification work

When the work item is a **no-PR verification** ticket (`target-kind`
`verification`), the coordinator produces no PR. Instead it:

1. Reads the ticket to identify the **named conformance suite** and the **deployed
   target** to validate (a live release, an ephemeral preview, etc.).
2. Confirms the target is reachable and at the expected revision, then runs the
   suite **read-only** against it — a verification never mutates the target. If
   passing would require a mutation, that is a structural failure (below).
3. Attaches the evidence to the ticket per §2.1/§2.3 (what ran, where, the result).
4. Advances the ticket along the §2.3 **forward path** to `verified` — the running
   suite is its `in-review`/`delivered` work, a passing suite its delivery — and
   records the §Definition of done artifact at `verified`. (No PR exists, so the
   path collapses onto whatever roles the tracker provides, per §2.3's
   graceful-degradation rule; the coordinator MUST NOT emit an unenumerated
   transition.) It holds a compute slot only while actually running the suite.

A verification that cannot pass reports a `failed` outcome (§Reporting) carrying a
`retryable` flag: **retryable** for a transient cause (target not yet at the
expected revision, image still building, flaky infrastructure — safe to re-run) or
**non-retryable** for a structural cause (acceptance is unmet in a way a re-run
cannot fix — needs a follow-up ticket and/or human action). The coordinator MUST
NOT transition a failed verification to `verified`.

## Injected bare PR

When the work item is a **single injected PR with no linked ticket**, the
coordinator's inputs are the PR's forge identity (`repo`, `pr_number`, `pr_url`,
`branch`) instead of `ticket_id`/`ticket_url`. With no ticket there is nothing to
claim, decompose, or transition: the coordinator simply drives the one PR to a
terminal state through §2.4 Delivery and reports a PR-terminal outcome —
`delivered` when the PR merges (terminal here, since a ticketless PR has no
separate verification step), `canceled`/`failed` when it closes without merging,
or `human-blocked` (non-terminal, §Human handoff) when delivery waits on an
operator response.
Its liveness lock is **PR-keyed** (§2.6 §Dispatch contract), not ticket-keyed.

If the injected PR **is** linked to a ticket, the coordinator instead behaves as a
normal ticket coordinator for that ticket — claiming it, owning its §2.3
transitions — with the PR as one of its §2.4 Delivery instances.

## Human handoff (worker-discovered)

When the coordinator determines that the ticket cannot proceed without a human
acting — a decision it cannot make autonomously, a credential it does not hold, a
manual step in an external system — it MUST:

1. Post an alert through the §2.3 routing rule (PR if one exists, else the
   ticket, else a new ticket), tagging at least one human, following §2.1. The
   alert MUST state what is needed and why the agent cannot proceed.
2. Transition the ticket to `awaiting-external` (or `paused` if the tracker lacks
   `awaiting-external`) per §2.3, emitting the state-change comment.
3. Emit a `WAIT` log entry naming the awaited venue and outcome.
4. Release the work: a dispatched coordinator writes its status (§Reporting) and
   exits; a standalone coordinator enters the §2.3 wait state on the chosen
   venue.

For a **PR item** there is no ticket status to park: the worker posts the
question on the PR thread (tagging a human per §2.1), records a
`human-blocked` outcome carrying a one-line version of the question, and
exits. The §2.6 tick alerts the operator once per episode; removing the
outcome requeues the item.

The coordinator MUST NOT block a session on input as a condition of forward
progress. Resolution follows §2.3: when a human responds with addressable
content, the ticket is resumed (parked → `available` per §2.3) and re-worked from
a fresh claim. The coordinator MUST ensure no more than one outstanding human
alert exists for the ticket at a time.

## Reporting

A **dispatched** coordinator MUST, as its final action, write an **outcome
artifact** for its caller. The artifact's location and transport are defined by the
dispatch contract (§2.6); its content MUST encode the outcome, which is one of:

| Outcome         | Meaning                                                                                                                                                        | Terminal?                 | How work resumes                                                                                                                                                            |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `verified`      | Ticket-backed only: aims validated and the §2.3 DoD artifact posted; ticket at `verified`.                                                                     | yes                       | —                                                                                                                                                                           |
| `canceled`      | Work abandoned: a ticket canceled per §2.3 with a rationale, or a ticketless bare PR closed without merging.                                                   | yes                       | —                                                                                                                                                                           |
| `delivered`     | The change landed. Ticket-backed: all required PRs merged but verification is owned elsewhere. Ticketless bare PR: the PR merged.                              | ticket: no / bare PR: yes | (ticket-backed) a separate verification coordinator (§2.6) takes it to `verified`; a bare PR is done.                                                                       |
| `human-blocked` | Parked in `awaiting-external` pending a human; alert posted. A PR item (no status to park) records this outcome directly; the tick alerts the operator (§2.6). | no                        | ticket: re-served as `resume` once a tracker update after the report moves it out of the parked state; PR item: the operator removes the outcome once the response arrives. |
| `decomposed`    | Split into subtasks; parent stays `in-progress`, effectively blocked by the subtasks.                                                                          | no                        | parent re-enters work and is finalized once all subtasks reach `verified`/`canceled` (§Decomposition, §2.6).                                                                |
| `failed`        | Could not complete; reason recorded (on the ticket, or in the artifact for a ticketless PR). Verification work carries a `retryable` flag.                     | no                        | a `retryable` verification failure auto-re-dispatches on a later tick (§2.6); otherwise the operator decides (retry, re-scope, cancel).                                     |

A **standalone** coordinator has no artifact obligation; it reports the same
outcome to the session and stops.

A dispatched coordinator MUST also honor any liveness obligations the dispatch
contract imposes (heartbeat, lock, label) per §2.6. A standalone coordinator has
none.

## Logging

The coordinator MUST emit §2.3 operational log entries for every role transition
(`TRANSITION`), wait (`WAIT`/`RESUME`), out-of-scope blocker (`BLOCK`), and
substantive non-state-change event (`INFO`), and MUST emit `ERROR` for tracker
errors and verification failures. State-change transitions MUST additionally be
echoed as §2.3 state-change comments on the primary venue.
