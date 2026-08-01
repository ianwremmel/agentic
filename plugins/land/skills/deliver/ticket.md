# deliver — ticket-backed runs

Applies only when Intake resolved a ticket.

## Resolving the tracker

A ticket URL names its own tracker (`linear.app/<workspace>/issue/DEV-123` →
`linear`); a bare id (`DEV-123`) uses `${user_config.tracker}`. Linear bindings
are below. For any other tracker, map its states onto these roles yourself
through its MCP server. When a native state's lifecycle meaning is ambiguous,
ask the operator rather than guess.

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
a native state or emit a transition to a role the tracker can't express: with
no `delivered` state the ticket stops at `in-review` when the PR ships — say so
and let the operator close it.

## Transitions

Each is bound to a PR lifecycle edge:

| Ticket edge               | Fires when                                                             |
| ------------------------- | ---------------------------------------------------------------------- |
| `available → in-progress` | Claiming, before the first push (below).                               |
| `in-progress → in-review` | The PR leaves `draft` — whichever edge your operator-mode file takes.  |
| `→ delivered`             | `<terminal state="shipped">`, **only if this PR completes the ticket**. |

A ticket that needs more than one PR stays `in-review` when this one lands:
record the shipped PR in a ticket comment and say which aims remain. Never
write `verified`; a run ends at `delivered`.

`<terminal state="abandoned">` transitions nothing. Report the closure on the
ticket and stop.

Every transition emits a `TRANSITION` log line and a state-change comment on
the ticket ([format](./reference.md#operational-logging)).

## Claim

Steps 1–3 run before the first push:

1. Resolve the current role and act on it:
   - `available` — claimable; continue.
   - `in-progress` or `in-review` assigned to **you** — a resumed run. Skip
     steps 2–3; don't re-emit the transition.
   - `in-progress` or `in-review` assigned to **anyone else** — they are on it.
     Report and stop.
   - anything else, including a native state that maps to no role — not
     claimable. Report and stop; moving it is the operator's call.
2. Assign the ticket to yourself.
3. Emit `available → in-progress`.
4. Once the PR exists, comment its URL on the ticket, and put the ticket's full
   URL (never a bare id) in the PR body.

## Linear bindings

| Operation      | Call                                                                                                          |
| -------------- | ------------------------------------------------------------------------------------------------------------- |
| fetch brief    | `get_issue(id, includeRelations=true)`; `list_comments(issueId)` when the acceptance criteria live in comments |
| resolve role   | `get_issue(id).state` → `list_issue_statuses(team)` → the role map below                                       |
| own identity   | `get_user("me")`                                                                                              |
| assign self    | `save_issue(id, assignee="me")`                                                                               |
| transition     | `save_issue(id, state=<substate mapping to the target role>)`                                                 |
| ticket comment | `save_comment(issueId, body)`                                                                                 |
| react          | `unsupported` — use the text tokens                                                                           |

Match `list_issue_statuses(team)` names case-insensitively:

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

Read the ticket's team before writing a state; substates are per-team.
