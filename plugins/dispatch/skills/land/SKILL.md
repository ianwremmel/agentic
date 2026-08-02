---
name: land
description: Take a single pull request to completion — draft it, drive CI and reviews, iterate, and monitor until it merges or closes. Starts from a PR URL, a ticket URL, or a freeform prompt. Stateless, one PR per run. Use whenever the unit of work is "land this change" and nothing broader.
---

# land

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
- Copilot review available: `${user_config.copilot_available}`. When `false`,
  skip the Copilot review stage; your operator-mode file has the edge that
  leaves `draft` without it.
- The worktree base is `${user_config.worktree_base}`.

Before any other work, read only these two files:

- `mode-${user_config.operator_mode}.md` — the lifecycle, states, and review
  gates for this operator mode.
- `credentials-${user_config.credential_mode}.md` — the wire format,
  notification venue, and review rules for this credential mode.

If either file does not exist, the config value is invalid — stop and ask the
operator to set `operator_mode` (`solo` or `team`) and `credential_mode`
(`dedicated` or `shared`) in the dispatch plugin config.

## Intake

One run drives exactly one PR. Resolve the input before Setup:

- **PR URL or number** — that PR, via the Resume path in Setup. The brief is its
  body plus its plan comment; a ticket link in the body makes the run
  ticket-backed. The snapshot carries neither, so read them from the API once,
  here at intake.
- **Ticket URL or bare id** — no PR yet. The ticket is the brief and the run is
  ticket-backed ([`ticket.md`](./ticket.md)).
- **Freeform prompt** — no PR, no ticket. The prompt is the brief.

Gates, lifecycle, and ending are the same for all three. A ticket-backed run
also keeps the ticket's role in sync and claims it before the first push; a run
with no ticket skips every ticket step.

Stop and ask the operator when the input names more than one PR, or when the
brief is too thin to tell when the change is done. Never invent scope.

## Setup

1. **Worktree.** Work in `${user_config.worktree_base}/<owner>/<repo>/<branch>`.
   Locate via `git worktree list` — never guess. Reuse if present.
2. **Open PR** (skip if one already exists for the branch):
   - `git commit --allow-empty -m "chore: open PR [skip ci]"` — never amend or
     squash this commit.
   - Push; open a **draft** PR. Body: Motivation, and the ticket link when
     there is one (full URL, never a bare id). **No execution plan in the
     body.**
   - Post the plan as a top-level comment with `<!-- agent-plan:<agent-id> -->`
     inside the wire-format body, on its own line and never first — the marker
     is first (see [`reference.md`](./reference.md#wire-format)). Pin if
     supported.
3. **Resume.** PR exists → reuse worktree, skip the open sequence, find the plan
   comment by its `agent-plan` marker (post one if missing). Never open a second
   PR or rewrite the body.

## Gates

Seven binary signals. Gates 1-5 are read from each `pr-status` XML; gates 6
and 7 are review outcomes, and may arrive somewhere the XML can't show (see
your credentials file):

1. **CI** — `<checks state="passing">` (rollup treats neutral/success as
   passing; repo can suppress non-blocking checks via `informational="true"`).
2. **No conflicts** — `<merge-conflicts present="false"/>`.
3. **No actionable annotations** — zero `<annotation actionable="true">`.
4. **No actionable comments** — zero `<comment actionable="true">`.
5. **No actionable threads** — zero `<thread actionable="true">`.
6. **Operator-approved** (always required). Your credentials file lists the
   signal forms that exist in this environment; your operator-mode file names
   the stage that satisfies it.
7. **Any second approval your operator-mode file requires.** That file says
   whether one exists here and what satisfies it.

Gates 1–5 are evaluated every tick outside `starting`/`done`. **Gate failures
are fixed in place — they don't change state.** Only the conditions on a
transition edge change state.

## Lifecycle

**Coding only happens in `draft`** — and in any other state only as the fix to
a gate-1–5 failure (CI broke, conflict, new actionable item). That fix is
"addressing concerns in place," not advancing the lifecycle.

### Ending the run

Two things end a run: the PR closes, or the operator says stop. Nothing else —
not a finished plan, not green CI, not a review request, not "there's nobody
left to ask." Re-decide this from the current `pr-status` every tick; never
carry a "stop when X" rule forward from an earlier one.

On either, read `<terminal state>` and do exactly what its row says:

| `<terminal state>` | What happened                        | Do                                                                                                              |
| ------------------ | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `shipped`          | The change is in the base branch.    | React `rocket` and reply `Shipped.`; run the ticket's final transition ([`ticket.md`](./ticket.md)); delete the worktree you created. |
| `abandoned`        | PR closed, change not in base.       | React `-1` and reply `Declined.`; report the closure on the ticket but don't advance its role; quote any `error=` attribute verbatim; delete the worktree you created. |
| `open` / `draft`   | PR still live — the operator stopped you. | Post what you finished and what is left; leave the PR open, the ticket untouched, and the worktree in place for a resumed run. Never close the PR. |

`shipped` covers a squash or rebase landing, not just a merge commit. Never
call a change delivered on any signal other than this attribute.

## Reading PR state

**Every gate and actionability decision comes from `pr-status` XML and the cache
files it writes** — never from `gh pr view`, `gh pr checks`, `gh api
…/comments|/reviews`, or an MCP PR read. Read full text from the cache. Direct
reads are allowed only for a field the snapshot omits: a thread's file and line,
and the PR body and plan comment at intake. `gh` and MCP are otherwise for **writes** — reply, react,
request review, mark ready.

A review still being drafted is invisible here by design. Don't chase it; wait
for `pr-status` to surface it.

## Per-concern handling

Address **every** actionable item, not just the first. `actionable="true"` is
your only task source: work the item, then reply and apply a terminal signal so
it settles. An item marked `actionable="false"` carries a `reason=` (`resolved`,
`agent-artifact`, `agent-terminal-reply`, `acked`) — leave it alone. `<summary>`
recaps what an item *says*, never whether it's resolved, so an item you already
settled still reads as open. That is expected, and never grounds to reopen it.

| XML signal                                            | Action                                                                    |
| ----------------------------------------------------- | ------------------------------------------------------------------------- |
| `<merge-conflicts present="true"/>` (gate 2)          | Rebase or merge the target branch; resolve.                               |
| `<checks state="failing">` (gate 1)                   | Diagnose root cause; fix.                                                 |
| Actionable `<comment>` or `<thread>` (gates 4–5)      | Reply (commit link **or** one-line dismissal naming what's dismissed) and apply a terminal signal. Dismissing a bot's point needs only that line; dismissing a human's needs you to say why their concern doesn't apply — if you can't say it, do what they asked. **Never resolve the thread** — even your own; that's a human's call, and the terminal signal already suppresses re-evaluation. |
| Actionable `<annotation>` (gate 3)                    | Fix the code, OR dismiss it: write the rationale to the path in `cache=` with `.md` swapped for `.ack` (a sibling file, not a child), and record it in the plan comment or commit body. |

## Cross-cutting behaviors

Apply in every state.

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
- **Plan comment is the living plan.** Edit in place: check off done steps,
  strike abandoned ones with a one-line rationale (don't delete), append new
  ones. The PR body stays stable.
- **First green.** Gate 1 needs a green rollup on the **current head commit** —
  the commit you intend to leave `draft` with. A green from an earlier push
  doesn't count.

## Polling

Adaptive, not fixed. **Never poll faster than once per minute.** Emit an INFO
heartbeat each time round ([`reference.md`](./reference.md#operational-logging);
`ticket=-` when there's no ticket).

A `pending` review is in-flight, not absent. Each reviewer appears once under
`<reviews>`, walking `pending → commented | changes_requested | approved |
dismissed`; a fresh request overrides any earlier verdict back to `pending`.
While anyone is `pending` — a `mode="bot"` reviewer especially — inline threads
can still land minutes later, so an unchanging thread set is **not**
convergence. Keep polling until `pending` clears.

| Waiting on                             | Schedule                                                                                 |
| -------------------------------------- | ---------------------------------------------------------------------------------------- |
| CI (`<checks state="pending">`)        | 60 s; lengthen to ~5 min once past the project's typical CI duration.                    |
| Reviewer reply after a request         | 5 min for the first hour; then 30 min.                                                    |
| Merge after `ready_for_merge`          | 5 min for the first hour; then 30 min.                                                    |

### Mechanism

The agent **is** the poll loop — inline, sequential foreground tool calls
(`Bash` `sleep`, then a `pr-status` re-read and any reactive work). Stay
continuously active in the current turn until the run ends; never yield
the turn, hand off to a wakeup, or expect re-prodding. Holds whether `land`
is invoked directly or dispatched as a subagent.

For waits past the Bash timeout (~10 min), split into shorter intervals (a
30-min wait ≈ 5×6-min `sleep`s, each followed by a cheap `pr-status` check).
Re-checking more often than the schedule is fine (never under 60 s); the table
is an upper bound.

**Forbidden** (each has stranded a PR):

- **Detached background poll loops** — any `run_in_background` Bash repeating
  `touch <lock>; sleep; poll` (`while`, `until`, `nohup`, `disown`, …). The OS
  process polls forever while the agent is reaped; the PR sits orphaned.
- **`Monitor` as the poll vehicle** — the armed-monitor wake observably fails on
  long polls. Use foreground `sleep`.
- **Ending the turn while the run is still going** — returning early for "no work
  right now" or "the caller will check back" orphans the PR. Don't design a
  caller around mid-lifecycle re-dispatch.

Tune the schedule within the run from what you observe: once you've watched this
repo's CI finish twice, poll on that duration rather than the table's head.

## References

Machine marker, terminal signals, engagement mechanics, actionability,
log-line format: [`reference.md`](./reference.md). Ticket
resolution, claiming, role sync: [`ticket.md`](./ticket.md).
