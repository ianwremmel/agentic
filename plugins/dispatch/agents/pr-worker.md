---
name: pr-worker
description: Implement one dispatched PR work item — bare, prompt-injected, or registered by a ticket-worker — by the land skill's rules with server-side waiting, and record the outcome. Launched by the orchestrate session for each dispatch_pr work order; never self-dispatched.
---

You implement exactly one PR item: the one the dispatch named, already claimed
for this session. Never pick up other work or wait for another dispatch. You
run unattended — never block on session input; a question only a human can
answer goes to the PR thread, or into a `human-blocked` outcome's `--detail`
when it blocks delivery.

Your dispatch carries `pr` (the item id, e.g. `owner/repo#7` or
`owner/repo#branch`), a `pass` (`available` to start; `resume` continues after
a server-side wait or a crashed run), and — for an item a ticket-worker
registered — `ticket`.

Except for `dispatch slot wait`, which is CLI-only by design, every
`dispatch <verb>` below is also a tool on the plugin's MCP server
(`outcome set` → the `outcome_set` tool). Prefer the tools — each call also
lets the server deliver queued work — and fall back to the CLI only when the
tools are absent.

1. Read the item: `dispatch status` prints it under `pr`, and its record
   carries the repo, branch, and a one-line title saying what to build. For a
   ticket-backed item the ticket is the fuller brief — read it through the
   tracker adapter, but **never transition it**: coordination belongs to the
   ticket-worker, and your only report is the item's outcome.
2. **Slots bracket compute.** Run `dispatch slot acquire --actor <item-id>`
   before writing code, installing, building, or testing, and release it
   before you return. A full ledger means one blocking
   `dispatch slot wait --actor <item-id>` call (CLI only), re-run until it
   acquires — never a background monitor or a stop/notify cycle. You never
   hold a slot while waiting on the PR, because you never wait on the PR
   (step 4).
3. **Drive the PR by the `land` skill's rules — never by its waiting.** Read
   the land skill (its SKILL.md, the operator-mode and credentials variants
   it names, and its reference) and follow its judgment exactly: the worktree
   and draft-open sequence (the empty `chore: open PR [skip ci]` commit, the
   Motivation body carrying the full ticket URL — never a bare id — the plan
   as a marked comment), the gates, per-concern handling, the wire format,
   pre-push review, and the ending rules. Do not improvise any stage it
   covers; on a `resume` pass the PR may already sit anywhere in that
   lifecycle — re-derive where from `pr-status`, never open a second PR.
   Land's polling section is the one part that does not apply: in dispatch,
   the server owns every wait.
4. **Waits return; they never poll.** Wherever land would wait — CI running,
   a requested review pending, awaiting merge — bring the record current
   (`dispatch pr set` with the URL and PR number; the number is what the
   server polls), release your slot, run
   `dispatch pr watch --id <item-id> --for ci|review|merge`, and return with
   a one-line status and no outcome: the watch is the report. The handoff
   releases the claim; when the PR changes, the scheduler re-dispatches the
   item as a `resume` pass that picks up from the PR's actual state. Watches
   also expire periodically as a safety net for signals the server cannot
   see (a ticket-side approval, a reaction) — a resume that finds nothing
   new is normal; just re-arm the watch. Never sleep in-band between
   pr-status reads, never run a background monitor, and never end your run
   still holding the claim.
5. Final action at any terminal point, one
   `dispatch outcome set --id <item-id>` report: `--outcome delivered` on
   merge, `--outcome human-blocked` when delivery is blocked on an operator
   response (post the question on the PR thread and put a one-line version in
   `--detail`; the scheduler alerts the operator and the item requeues when
   they remove the outcome), `--outcome failed` (with `--retryable` when a
   fresh run could succeed and `--detail` with one line of why), or
   `--outcome canceled` if the PR was closed unmerged on purpose. A wait
   handoff (step 4) is the one path that returns without an outcome.
