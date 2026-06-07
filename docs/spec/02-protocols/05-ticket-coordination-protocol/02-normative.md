# §2.5.2 — Ticket Coordination Protocol: Normative

## Applicability

This protocol applies to any agent responsible for driving a **single tracked
ticket** to a terminal §2.3 role by producing and landing the pull request(s) its
aims require — usually one, sometimes several. A coordinator may land **no** PR at
all when the ticket is decomposed, handed to a human, or canceled before any
implementation begins. The agent is a **coordinator**.

A coordinator MAY be invoked standalone (a human names one ticket) or dispatched
by an orchestrator (§2.6). The rules below are identical in both contexts; only
the reporting surface (§Reporting) differs.

A coordinator is explicitly assigned a tracked work item and is therefore subject
to the §2.3 communication restriction for the life of its assignment.

The ticket may live on any tracker supported by §2.3. Reads and writes to the
tracker follow §2.1 mode rules; the access mechanism (API, CLI, MCP) is
implementation-defined and orthogonal to the §2.1 mode.

## Inputs

A coordinator MUST be able to operate from only:

- `ticket_id` — the tracker-native identifier.
- `ticket_url` — the canonical URL.

A caller MAY additionally supply non-authoritative hints (a branch-name seed, a
target-kind hint, a commit scope). A coordinator MUST NOT require any ticket
*content* to be passed in. It MUST fetch the ticket's description, acceptance
criteria, dependencies, and links itself.

## Claiming

Before doing any work the coordinator MUST claim the ticket:

1. Resolve the ticket's current §2.3 role.
2. If the ticket is already in a `started` role assigned to a *different* agent
   identity, the coordinator MUST NOT proceed (§2.3 multi-agent coordination).
3. Assign the ticket to the coordinator's own agent identity.
4. Transition the ticket `available → in-progress` per §2.3, emitting the
   state-change comment and `TRANSITION` log entry.

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
transitioning it to `verified` (or `canceled`) — is a later, separate coordinator
pass, not part of this run. The decomposing coordinator MUST record each subtask
as a `blocks` edge to the parent (§2.3 §Dependencies) so the parent is effectively
blocked by its subtasks, emit a `decomposed` outcome (§Reporting), and stop. Under
an orchestrator the parent's finalization is scheduled per §2.6 (it re-enters work
once every subtask is `verified`/`canceled`); a standalone coordinator reports the
open subtasks and the pending parent finalization to the session.

## PR production

For each in-scope unit of work, the coordinator MUST drive a pull request to a
terminal state through the Delivery Protocol (§2.4). Each PR is a distinct §2.4
Delivery instance.

- The coordinator SHOULD run its PRs **sequentially** — at most one non-terminal
  PR at a time — to keep PRs small and to consume a single orchestrator slot.
- It MAY run PRs concurrently only when the ticket's work is genuinely independent
  **and** the orchestrator has free slots to grant; each additional concurrent
  worker consumes an additional slot (§2.6 §Slot accounting). Absent a free-slot
  grant, the coordinator MUST sequence.
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

The coordinator MUST NOT block a session on input as a condition of forward
progress. Resolution follows §2.3: when a human responds with addressable
content, the ticket is resumed (parked → `available` per §2.3) and re-worked from
a fresh claim. The coordinator MUST ensure no more than one outstanding human
alert exists for the ticket at a time.

## Reporting

A **dispatched** coordinator MUST, as its final action, write an **outcome
artifact** for its caller. The artifact's location and transport are defined by the
dispatch contract (§2.6); its content MUST encode the outcome, which is one of:

| Outcome         | Meaning                                                                                          | Terminal? | How work resumes                                                                                             |
| --------------- | ------------------------------------------------------------------------------------------------ | --------- | ------------------------------------------------------------------------------------------------------------ |
| `verified`      | Ticket reached `verified`; aims validated and DoD artifact posted.                               | yes       | —                                                                                                            |
| `canceled`      | Ticket canceled per §2.3 with a rationale.                                                       | yes       | —                                                                                                            |
| `delivered`     | All required PRs landed but verification is owned elsewhere (e.g. a separate verification gate). | no        | a verification agent / gate (§2.6) takes it to `verified`.                                                   |
| `human-blocked` | Parked in `awaiting-external` pending a human; alert posted.                                     | no        | re-dispatched from a fresh claim once the human resolves it.                                                 |
| `decomposed`    | Split into subtasks; parent stays `in-progress`, effectively blocked by the subtasks.            | no        | parent re-enters work and is finalized once all subtasks reach `verified`/`canceled` (§Decomposition, §2.6). |
| `failed`        | Could not complete; reason recorded on the ticket and in the artifact.                           | no        | operator decides (retry, re-scope, or cancel).                                                               |

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
