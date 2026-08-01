---
name: deliver
description: Drive one code change to merge through a draft PR — CI, reviews, iteration, monitor until close. Starts from a PR URL, a ticket URL, or a freeform prompt. Use whenever the unit of work is "land this change."
---

# deliver

Land a code change via a PR. Each tick: run `pr-status <pr>`, address every
actionable concern, then evaluate the gates to decide whether to transition.

**Operator** = the one human directing this agent; the only human with stop
authority. Role glossary in [`reference.md`](./reference.md#roles).

## Environment

Fixed by plugin config. State these in your first status output; never infer
any of them:

- The operator is `${user_config.operator_login}`.
- The operator mode is `${user_config.operator_mode}`.
- The credential mode is `${user_config.credential_mode}`.
- Copilot review available: `${user_config.copilot_available}`.
- The worktree base is `${user_config.worktree_base}`.

Before any other work, read the two files for this environment — and only
these two; the other mode files describe environments you are not in:

- `mode-${user_config.operator_mode}.md` — the lifecycle, states, and review
  gates for this operator mode.
- `credentials-${user_config.credential_mode}.md` — the wire format,
  notification venue, and review rules for this credential mode.

If either file does not exist, the config value is invalid — stop and ask the
operator to set `operator_mode` (`solo` or `team`) and `credential_mode`
(`dedicated` or `shared`) in the land plugin config.

## Intake

One run drives exactly one PR to one terminal. The input arrives in one of
three forms; resolve it before Setup:

- **PR URL or number** — that PR, via the Resume path in Setup. The brief is its
  body plus its plan comment; a ticket link in the body makes the run
  ticket-backed.
- **Ticket URL or bare id** — no PR yet. The ticket is the brief and the run is
  ticket-backed ([`ticket.md`](./ticket.md)).
- **Freeform prompt** — no PR, no ticket. The prompt is the brief.

The brief's source changes nothing downstream: same gates, same lifecycle, same
terminal. A ticket-backed run additionally keeps the ticket's role in sync and
claims it before the first push ([`ticket.md`](./ticket.md)); a run with no
ticket skips every ticket step.

Stop and ask the operator when the input names more than one PR, or when the
brief is too thin to write a test plan against. Never invent scope.

## Setup

1. **Worktree.** Work in `${user_config.worktree_base}/<owner>/<repo>/<branch>`.
   Locate via `git worktree list` — never guess. Reuse if present.
2. **Open PR** (skip if one already exists for the branch):
   - `git commit --allow-empty -m "chore: open PR [skip ci]"` — never amend or
     squash this commit.
   - Push; open a **draft** PR. Body: Motivation, Ticket link (omit if none —
     no bare IDs), Test plan. **No execution plan in the body.**
   - Post the plan as a top-level comment with `<!-- agent-plan:<agent-id> -->`
     inside the wire-format body (after the marker/sparkle, not as the first
     line; see [`reference.md`](./reference.md#wire-format)). Pin if supported.
3. **Resume.** PR exists → reuse worktree, skip the open sequence, find the plan
   comment by its `agent-plan` marker (post one if missing). Never open a second
   PR or rewrite the body.

## Gates

Seven binary signals read from each `pr-status` XML:

1. **CI** — `<checks state="passing">` (rollup treats neutral/success as
   passing; repo can suppress non-blocking checks via `informational="true"`).
2. **No conflicts** — `<merge-conflicts present="false"/>`.
3. **No actionable annotations** — zero `<annotation actionable="true">`.
4. **No actionable comments** — zero `<comment actionable="true">`.
5. **No actionable threads** — zero `<thread actionable="true">`.
6. **Operator-approved** (always required). Which signal forms are available —
   and the lifecycle stage where it's satisfied — come from your credentials
   and operator-mode files. The full set:
   - `<review mode="human" role="operator" state="approved">` (dedicated
     credentials only), or
   - `<reaction emoji="+1">` from the operator on the engagement comment, or
   - a "go ahead"/"lgtm"/"ready" reply from the operator (on the
     engagement comment, the ticket, or out-of-band), or
   - a ticket-side approval (e.g. operator status transition).
7. **Team-approved** (team operator mode only; trivially satisfied in solo).
   Defined in your operator-mode file.

Gates 1–5 are evaluated every tick outside `starting`/`done`. **Gate failures
are fixed in place — they don't change state.** Only the conditions on a
transition edge change state.

## Lifecycle

**Coding only happens in `draft`** — and in any other state only as the fix to
a gate-1–5 failure (CI broke, conflict, new actionable item). That fix is
"addressing concerns in place," not advancing the lifecycle.

### Universal terminal

From any state: PR closed, or operator "stop" → read `<terminal>` from
`pr-status` → acknowledge with a terminal signal → `merged` → `done`.
`<terminal state>` is binary — *did the change ship*, not *how*:

- **`shipped`** — change present in base (merged, fast-forward, or squash/rebase
  by external tooling). Acknowledge delivered (`Shipped.`/`rocket`), then run the
  ticket's terminal transition ([`ticket.md`](./ticket.md)).
- **`abandoned`** — closed with change absent. Acknowledge not-delivered, don't
  advance the ticket. Surface any `error=` breadcrumb — never claim delivery on
  a guess.

On any closure, remove any worktree you created.

## Per-concern handling

Apply to **every** actionable item, not just the first.

| XML signal                                            | Action                                                                    |
| ----------------------------------------------------- | ------------------------------------------------------------------------- |
| `<merge-conflicts present="true"/>` (gate 2)          | Rebase or merge the target branch; resolve.                               |
| `<checks state="failing">` (gate 1)                   | Diagnose root cause; fix.                                                 |
| Actionable `<comment>` or `<thread>` (gates 4–5)      | Reply (commit link **or** one-line dismissal naming what's dismissed) and apply a terminal signal. **Never resolve the thread** — even your own; that's a human's call, and the terminal signal already suppresses re-evaluation. |
| Actionable `<annotation>` (gate 3)                    | Fix the code, OR dismiss with a `<cache>/$id.ack` carrying the rationale (also record it in the plan comment or commit body). |

## Cross-cutting behaviors

Apply in every state.

- **Read PR state only through `pr-status`.** Every gate and actionability
  decision comes from a `pr-status` XML snapshot and the cache it wrote — never
  `gh pr view`, `gh pr checks`, `gh api …/comments|/reviews`, or MCP PR reads.
  For full text, read the cache file `pr-status` already wrote. You may directly
  fetch *emergent* data the snapshot doesn't cover, but routine `gh`/MCP calls
  are *writes only* (reply, request review, mark ready, react — never resolve
  threads). A review still being *drafted* (unsubmitted) is invisible by design;
  don't chase it — wait for `pr-status` to surface it.
- **`actionable` is the sole task source.** Drive every decision off
  `actionable="true|false"`. A non-actionable item also carries `reason=`
  (`resolved`, `agent-artifact`, `agent-terminal-reply`, `acked`). A `<summary>`
  is a **reading aid, not a work queue**: read it plus the new cache content when
  an item is actionable; ignore it as context when not. A summary describes the
  item's *content*, not its *resolution*, so an item you already terminal-tagged
  reads as if the point still stands — expected. Never let summary prose
  re-actionable a suppressed item.
- **A `pending` review is in-flight, not absent.** Each reviewer appears once
  under `<reviews>` walking `pending → commented | changes_requested |
  approved | dismissed`. An outstanding request overrides a prior verdict back
  to `pending` (re-requested Copilot/operator). While any reviewer is `pending` — especially
  a `mode="bot"` one — inline threads can still land minutes later, so a stable
  thread set is **not** convergence. Keep polling until `pending` clears.
- **Pre-push review.** Before every significant push, run two adversarial
  passes:
  1. *Spec-aware* — spec/docs + PR contents: find every drift from the spec
     (missing, extra, or conflicting behavior).
  2. *Spec-blind* — PR contents only: find every bug, inconsistency, or
     claim-vs-implementation gap (judged against the PR's own commit
     messages/identifiers/comments).

  Use a **model family distinct from the authoring one** for both passes where
  the install has one (e.g. Codex `codex:adversarial-review`/`codex:rescue` when
  Claude authored). A second subagent on the authoring model does NOT count.
  Only where no distinct family exists may both fall back to authoring-model
  subagents (weaker — extra caution). Triage every finding (act, or one-line
  dismissal naming it). Skip pre-push review only for non-significant pushes
  (the empty open commit, whitespace/format-only, trivial typo/lint); if unsure,
  treat as significant.
- **Reply to every reviewer item** — commit link or dismissal rationale.
  Silence is non-conforming. Humans get more deference than bots.
- **Plan comment is the living plan.** Edit in place: check off done steps,
  strike abandoned ones with a one-line rationale (don't delete), append new
  ones. The PR body's Motivation/Test plan stay stable.
- **First green.** Gate 1 needs a green rollup achieved *after* the agent first
  attempts to leave `draft`. Earlier greens don't count.
- **Heartbeats.** While polling, emit INFO heartbeats (see
  [`reference.md`](./reference.md#operational-logging); `ticket=-` when none).
- **Termination is narrow.** Only PR closure or explicit operator "stop"
  terminates. Plan completion, green CI, review requests, `ready_for_merge`, and
  "nobody to ask" do not. The agent runs the loop through itself (see Polling) and
  is never re-prodded.
- **Re-derive termination each tick** from the current `pr-status`. Never carry
  "if X then stop" across ticks — the loop amplifies them.

## Polling

Adaptive, not fixed. **Never poll faster than once per minute.**

| Waiting on                             | Schedule                                                                                 |
| -------------------------------------- | ---------------------------------------------------------------------------------------- |
| CI (`<checks state="pending">`)        | 60 s; lengthen to ~5 min once past the project's typical CI duration.                    |
| Reviewer reply after a request         | 5 min for the first hour; then 30 min.                                                    |
| Merge after `ready_for_merge`          | 5 min for the first hour; then 30 min.                                                    |

### Mechanism

The agent **is** the poll loop — inline, sequential foreground tool calls
(`Bash` `sleep`, then a `pr-status` re-read and any reactive work). Stay
continuously active in the current turn until a lifecycle terminal; never yield
the turn, hand off to a wakeup, or expect re-prodding. Holds whether `deliver`
is invoked directly or dispatched as a subagent.

For waits past the Bash timeout (~10 min), split into shorter intervals (a
30-min wait ≈ 5×6-min `sleep`s, each followed by a cheap `pr-status` check).
Re-checking more often than the schedule is fine; the table is an upper bound.

**Forbidden** (each has stranded a PR):

- **Detached background poll loops** — any `run_in_background` Bash repeating
  `touch <lock>; sleep; poll` (`while`, `until`, `nohup`, `disown`, …). The OS
  process polls forever while the agent is reaped; the PR sits orphaned.
- **`Monitor` as the poll vehicle** — the armed-monitor wake observably fails on
  long polls. Use foreground `sleep`.
- **Ending the turn before a lifecycle terminal** — returning early for "no work
  right now" or "the caller will check back" orphans the PR. Don't design a
  caller around mid-lifecycle re-dispatch.

At a lifecycle terminal (or a caught operator "stop") remove any worktree you
created and run the ticket's terminal transition. Nothing persists between runs:
a run that dies abnormally (API error, OOM, reaping) leaves the PR where it was,
and the next `/land:deliver <pr-url>` re-derives everything from `pr-status`.

Tune the schedule within the run from what you observe: once you've watched this
repo's CI finish twice, poll on that duration rather than the table's head.

## References

The machine marker + sparkle wrapper, terminal signals, engagement mechanics,
actionability, and the log-line format live in
[`reference.md`](./reference.md). Ticket resolution, claiming, and role sync
live in [`ticket.md`](./ticket.md).
