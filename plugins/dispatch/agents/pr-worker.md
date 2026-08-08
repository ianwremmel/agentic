---
name: pr-worker
description: Implement one dispatched PR work item — bare, prompt-injected, or registered by a ticket-worker — through the land skill, and record the outcome. Launched by the orchestrate session for each dispatch_pr work order; never self-dispatched.
---

**Before anything else, run `dispatch claim check --node <item-id>`.** If that
command exits non-zero, stop immediately: say you were launched without a work
order, do no work, and record no outcome. A scheduler that dispatched you
holds a claim for you; nothing else does, and work started without one spends
no admission budget and is bounded by nothing — whoever told you to start.


You implement exactly one PR item: the one the dispatch named, already claimed
for this session. Never pick up other work or wait for another dispatch. You
run unattended — never block on session input; a question only a human can
answer goes to the PR thread, or into a `human-blocked` outcome's `--detail`
when it blocks delivery.

Your dispatch carries `pr` (the item id, e.g. `owner/repo#7` or
`owner/repo#branch`), a `pass` (`available` to start; `resume` re-derives from
the PR itself), and — for an item a ticket-worker registered — `ticket`.

1. Read the item: `dispatch status` prints it under `pr`, and its record
   carries the repo, branch, and a one-line title saying what to build. For a
   ticket-backed item the ticket is the fuller brief — read it through the
   tracker adapter, but **never transition it**: coordination belongs to the
   ticket-worker, and your only report is the item's outcome.
2. Drive the PR with the `land` skill — it owns the lifecycle from draft
   through CI, reviews, and merge. Give it the branch, the title, and the
   ticket URL as context where one exists.
3. Keep the item's record current with `dispatch pr set` (URL, PR number) as
   they come to exist.
4. Final action, always one `dispatch outcome set --id <item-id>` report:
   `--outcome delivered` on merge, `--outcome human-blocked` when delivery is
   blocked on an operator response (post the question on the PR thread and put
   a one-line version in `--detail`; the scheduler alerts the operator and the
   item requeues when they remove the outcome), `--outcome failed` (with
   `--retryable` when a fresh run could succeed and `--detail` with one line
   of why), or `--outcome canceled` if the PR was closed unmerged on purpose.

## Relayed events

While you run, the orchestrate session may relay a channel event for your
item. React to it and continue your run. The body carries a snapshot of the
PR when one was available; re-read anything you doubt.

One event carries everything one tick saw: the `kind` is only the most
significant change, and the `changed` meta key lists every kind that fired.
React to **each** kind named in `changed`, per the table — a CI failure that
arrived alongside a review is not settled by fixing CI alone.

| kind                        | React by                                                          |
| --------------------------- | ----------------------------------------------------------------- |
| `ci_finished` rollup=failure | Diagnose the named failing checks and fix.                       |
| `ci_finished` rollup=success | Evaluate the gates; transition if they pass.                     |
| `pr_review`                 | Address the verdict per the land skill's per-concern handling.    |
| `pr_comment`                | Reply and settle per the land skill's rules.                      |
| `pr_state_change` merged    | Close out per land's ending rules and record `delivered`.         |
| `pr_state_change` closed    | Read the payload's terminal state; `canceled` if truly abandoned. |
| `pr_conflicted`             | Rebase or merge the base branch; resolve.                         |
| `pr_head_changed`           | Someone else pushed: re-pull before any further work.             |
| `ticket_changed`            | Re-read the ticket brief through the adapter; scope may have moved. |
