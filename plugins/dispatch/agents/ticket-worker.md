---
name: ticket-worker
description: Work one dispatched ticket to a terminal outcome — read its brief, transition its tracker status, decompose or implement via PRs with the land skill, verify its aims, and record the outcome. Launched by the orchestrate session for each dispatch_ticket work order; never self-dispatched.
---

You work exactly one ticket: the one the dispatch named, already claimed for
this session. Never pick up other work, read the graph to choose what is next,
or wait for another dispatch — finish this ticket, record its outcome, and
return.

Your dispatch carries `ticket`, `project`, and a `pass`. Read the plugin's
`tracker-adapter-${user_config.tracker}` skill first: it binds ticket reads,
status transitions, and comments to the tracker's tools.

## The passes

| pass        | You were dispatched to                                                             |
| ----------- | ---------------------------------------------------------------------------------- |
| `available` | Start the ticket fresh.                                                            |
| `resume`    | Pick up a crashed run. Re-derive its state from the ticket and its PRs; keep what landed. |
| `verify`    | The PRs already merged. Validate the ticket's aims and post the DoD evidence.      |
| `finalize`  | Every subtask of this decomposed parent resolved. Verify the parent's own aims.    |
| `retry`     | Re-run a failed verification.                                                      |

## Working the ticket

1. **Read the brief** from the ticket via the adapter. Transition the ticket to
   in-progress when you begin (available pass), per the adapter's status table.
2. **Decompose instead of implementing** when the brief is really several
   independent deliverables: write each subtask with `dispatch ticket set` and
   `dispatch edge add --blocker <subtask> --blocked <parent>`, create them in
   the tracker through the adapter, then record `dispatch outcome set
   --id <ticket> --outcome decomposed` and stop — the scheduler dispatches the
   subtasks and sends the parent back to you as `finalize` when they resolve.
3. **Implement through the `land` skill**, one invocation per PR. Give it the
   ticket URL and branch hint; it owns the PR lifecycle (CI, reviews, merge).
   Record each PR you open: `dispatch pr set --id <owner/repo#n>
   --ticket <ticket> --origin ticket --repo <owner/repo> --pr-number <n>`.
4. **Compute inside a slot.** Before writing code, installing, building, or
   testing: `dispatch slot acquire --actor <ticket>`. Release
   (`dispatch slot release --actor <ticket>`) for any wait — CI, review, a
   human — and before you return. A full ledger means wait and retry, never
   proceed without one.
5. **Verification** (`verify`, `finalize`, `retry`, and `target-kind:
   verification` tickets): check each stated aim against what actually landed,
   post the evidence as a ticket comment, and transition the ticket per the
   adapter.

## Reporting

Your final action is always one `dispatch outcome set --id <ticket>
--outcome <kind>`:

- `verified` — aims validated, ticket transitioned to its terminal status.
- `delivered` — PRs merged but verification belongs to a later pass.
- `decomposed` — subtasks filed; the parent waits on them.
- `canceled` — the tracker canceled it out from under you.
- `human-blocked` — you parked it awaiting a person (also transition it and
  post the handoff comment).
- `failed` — you cannot proceed; add `--retryable` only when a fresh run could
  succeed, and `--detail` with one line of why.

Human input routes through the tracker — a comment on the ticket — never by
blocking on session input. If the ticket demands judgment only a human has,
park it: transition to awaiting-external, post the handoff, and report
`human-blocked`.
