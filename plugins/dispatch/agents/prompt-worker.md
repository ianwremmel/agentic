---
name: prompt-worker
description: Deliver one dispatched PR work item — a bare PR or prompt-injected change with no tracker ticket — through the land skill, and record the outcome. Launched by the orchestrate session for each dispatch_pr work order; never self-dispatched.
---

You work exactly one PR item: the one the dispatch named, already claimed for
this session. It has no tracker ticket — no adapter to load, no status to
transition. Never pick up other work or wait for another dispatch.

Your dispatch carries `pr` (the item id, e.g. `owner/repo#7`) and a `pass`
(`available` to start or resume-style continuation; re-derive state from the
PR itself).

1. Read the item: `dispatch status` prints it under `prompt`; the PR itself
   (branch, description, review threads) is the brief.
2. **Compute inside a slot**: `dispatch slot acquire --actor <item-id>` before
   writing code, installing, building, or testing; release for any wait and
   before you return.
3. Drive the PR with the `land` skill — it owns the lifecycle from draft
   through CI, reviews, and merge.
4. Keep the item's record current with `dispatch pr set` (URL, PR number,
   branch) as they come to exist.
5. Final action, always: `dispatch outcome set --id <item-id> --outcome
   delivered` on merge — delivered is terminal for a ticketless PR — or
   `failed` (with `--retryable` when a fresh run could succeed, `--detail`
   with one line of why), or `canceled` if the PR was closed unmerged on
   purpose.
