---
name: deliver
description: Drive a code change to merge through a draft PR — CI, reviews, iteration, monitor until close. Use whenever the unit of work is "land this change," whether the trigger is a prompt or a ticket. Implements the Delivery Protocol (§2.4) using the PR Status Protocol (§2.2) for state.
---

# deliver

Land a code change via a PR. Loop on PR state until close.

## Setup

1. **Worktree.** Work inside `~/.worktrees/<owner>/<repo>/<branch>` (or repo override). Find existing with `git worktree list` — never guess. Reuse if present.
2. **PR-open sequence** (skip if a PR is already open for this branch):
   - `git commit --allow-empty -m "chore: open PR [skip ci]"` — never amend or squash this commit.
   - Push; open a **draft** PR. Body: Motivation, Ticket link (omit entirely if none — bare IDs are non-conforming), Test plan. **No execution plan in the body.**
   - Post the plan as a top-level PR comment. Include `<!-- agent-plan:<agent-id> -->` inside the §2.1 body (after the machine marker / sparkle line, not before). Pin if supported.
3. **Resuming.** If a PR already exists: reuse worktree, skip 1–2, find the existing plan comment by its `agent-plan` marker. If missing, post one. Never open a second PR; never retroactively rewrite the body.

## Loop

Run `scripts/pr-status <pr>` with `DISPATCH_AGENT_ID` and `DISPATCH_SKILL=deliver` in env. Read the XML. Take the first matching action below. Re-run after each action.

| Signal                                                                        | Action                                                                                                              |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `<merge-conflicts present="true"/>`                                           | Rebase or merge target; resolve; push.                                                                              |
| `<checks state="failing">`                                                    | Diagnose root cause. Fix. Pre-push review. Push.                                                                    |
| Any actionable `<comment>` / `<thread>` / `<annotation>`                      | Reply per §2.1 with **either** a commit link describing what changed **or** a one-line dismissal rationale. Terminal signal where applicable. Annotations: address or write `<cache-dir>/<id>.ack`. |
| `<checks state="pending">`                                                    | Emit INFO heartbeat (§2.3). Wait. Do not push speculative fixes.                                                    |
| No real commits since PR open                                                 | Implement. Run **simplify** + adversarial review (different reviewer than the writer). Triage every finding. Push.  |
| Ready for review + first-green CI achieved + no Copilot review requested yet  | Request Copilot review (Stage 1). Skip stage if Copilot review unavailable on this installation.                    |
| Passing CI + zero actionable Copilot threads + still draft                    | Clear draft. Request human review (Stage 2). Mode A: GitHub review request. Mode B: tag human on the ticket.        |
| All gates clear, nothing actionable                                           | Heartbeat. Monitor. Do not exit.                                                                                    |
| PR merged or closed; or human explicitly says "stop"                          | Acknowledge per §2.1. Remove any worktree **you** created. Exit.                                                    |

## Rules

- **First green** = a green CI rollup reached *after* you decided the change is ready. Greens on intermediate commits don't count.
- **Significant push** triggers the pre-push review pair (simplify + adversarial). Non-significant: empty `chore: open PR`, whitespace/format-only, trivial typo/lint fixes. If unsure, treat as significant.
- **Plan comment** is the living plan: edit in place. Check off completed steps, strike through abandoned ones with a one-line rationale (don't delete), append new ones. The PR body's Motivation and Test plan stay stable.
- **Every reviewer comment gets a reply** with either commit link or dismissal rationale. Silence is non-conforming. Give human comments more deference than bots'.
- **Termination is narrow.** Do not stop because the plan is done, CI is green, or review was requested. Only PR close or explicit human "stop" terminates.

## References

- §2.4.2 Delivery Protocol
- §2.2.2 PR Status Protocol
- §2.1.2 Communication Protocol (machine marker, Mode A/B sparkle wrapper, terminal signals)
- §2.3 Operational logging (heartbeats, `TRANSITION` entries)
