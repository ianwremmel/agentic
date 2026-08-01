# deliver — ticket-backed runs

Applies only when Intake resolved a ticket. Everything here is additive — the
PR lifecycle in your operator-mode file is unchanged.

## Resolving the tracker

A ticket URL names its own tracker (`linear.app/<workspace>/issue/DEV-123` →
`linear`); a bare id (`DEV-123`) uses `${user_config.tracker}`. Reach the
tracker through its MCP server. The Linear bindings below ship with this skill;
any other tracker is driven best-effort through whatever its own MCP server
exposes, mapping its states onto the roles below yourself. Escalate to the
operator rather than guess when a native state's lifecycle meaning is ambiguous
— a wrong transition strands real work.

## Roles

Speak these role names, never a tracker's own state names.

| Role          | Meaning                                          |
| ------------- | ------------------------------------------------ |
| `available`   | Eligible to be picked up.                        |
| `in-progress` | Actively being worked.                           |
| `in-review`   | Primary work complete; iterating with reviewers. |
| `delivered`   | Merged or deployed; not yet verified.            |
| `verified`    | Validated against the ticket's aims. Read-only.  |
| `canceled`    | Will not be done.                                |

Forward path — `available → in-progress → in-review → delivered`. Never invent
a native state to fill a gap, and never emit a transition to a role the tracker
can't express: on a tracker with no `delivered` role the ticket stops at
`in-review` when the PR ships. Say so and let the operator close it.

## Transitions

Each is bound to a PR lifecycle edge:

| Ticket edge               | Fires when                                                             |
| ------------------------- | ---------------------------------------------------------------------- |
| `available → in-progress` | Claiming, before the first push (below).                               |
| `in-progress → in-review` | The agent first engages a reviewer — the edge out of `draft`.          |
| `→ delivered`             | `<terminal state="shipped">`, **only if this PR completes the ticket**. |

A ticket that needs more than one PR stays `in-review` when this one lands:
record the shipped PR in a ticket comment and say which aims remain. `verified`
is never this skill's to write — it asserts the ticket's aims were validated,
which outlives the PR. `delivered` is where a run ends.

`<terminal state="abandoned">` transitions nothing. Report the closure on the
ticket and stop; whether the ticket is dead is the operator's call.

Every transition emits a `TRANSITION` log line and a state-change comment
([format](./reference.md#operational-logging)) — on the ticket, since these are
ticket-level.

## Claim

Steps 1–3 run before the first push, in order:

1. Resolve the current role. A `started` role held by a **different** platform
   identity means someone else is on it — stop and report.
2. Assign the ticket to yourself.
3. Emit `available → in-progress`, unless it is already `in-progress` as you
   (a resumed run) — then don't re-emit.
4. Comment the PR URL on the ticket once the PR exists, and put the ticket's
   full URL (never a bare id) in the PR body.

A terminal ticket (`verified`, `canceled`) is not claimable — report and stop.
A ticket sitting in a backlog or paused state moves through `available` first,
never straight to `in-progress`.

## Linear bindings

| Operation      | Call                                                                                                          |
| -------------- | ------------------------------------------------------------------------------------------------------------- |
| fetch brief    | `get_issue(id, includeRelations=true)`; `list_comments(issueId)` when the acceptance criteria live in comments |
| resolve role   | `get_issue(id).state` → `list_issue_statuses(team)` → the role map below                                       |
| own identity   | `get_user("me")`                                                                                              |
| assign self    | `save_issue(id, assignee="me")`                                                                               |
| transition     | `save_issue(id, state=<substate mapping to the target role>)`                                                 |
| ticket comment | `save_comment(issueId, body)`                                                                                 |
| react          | `unsupported` — no reaction call in the Linear MCP server; use the text tokens                                |

Read the team's substates with `list_issue_statuses(team)` and match by name,
case-insensitively:

| Native substate | Role          |
| --------------- | ------------- |
| Todo            | `available`   |
| In Progress     | `in-progress` |
| In Review       | `in-review`   |
| Delivered       | `delivered`   |
| Done            | `verified`    |
| Canceled        | `canceled`    |

`Delivered` is a custom substate; a team without it leaves the ticket at
`In Review` on ship. A substate this table doesn't name is an escalation, not a
guess — a team's custom `Blocked` sits in Linear's `Unstarted` group and is not
`available`.

Linear tickets are per-team: read the ticket's team before writing a state, and
never reuse another team's substate names.
