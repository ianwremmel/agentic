# §2.4.1 — Delivery Protocol: Narrative

## Design goals

The Delivery Protocol exists to ensure three things hold whenever an agent
changes code:

1. **Agents don't pollute the main worktree.** The user's primary checkout stays
   clean. Agent work happens in isolated worktrees so concurrent sessions don't
   step on each other or on the user.

2. **Work goes through the appropriate quality gates.** Every change passes
   pre-push review, CI, and the reviewer-progression stages in a uniform order.
   Nothing reaches a human reviewer that hasn't already been examined by the
   available automation.

3. **Humans are not engaged while automation is still in play.** The protocol
   holds human review until automated signals (CI, Copilot, adversarial pre-push
   review) have done their work. Humans only see PRs whose remaining questions
   genuinely require human judgment.

4. **The operator gets the first look in a team.** Where a repository has more
   human reviewers than just the operator, the operator reviews privately —
   while the PR is still in draft — before the broader team is engaged.
   Clearing draft is a public act, and the operator should get the chance to
   shape the change before it goes team-wide.

## Stage overview

Work flows through up to seven stages:

```
Worktree setup → PR open → Implementation → Pre-push review → CI + Copilot →
  [Private review (team mode only, in draft)] → Public review → Termination
```

Each stage has a precondition (what must be true before entering it) and a
postcondition (what the agent emits or achieves before leaving it). The stages
are not strictly sequential — implementation and CI may interleave, and
iteration loops back from review to implementation — but the overall direction
is left-to-right.

### Solo vs team mode

Whether the private review stage appears at all is a per-installation choice
expressed by the `team_mode` configuration. In **solo mode** (the default), the
operator is the only human reviewer; the agent clears draft after Copilot and
the operator is engaged as the public reviewer directly. In **team mode**, the
operator is one of several human reviewers and gets a private pre-review while
the PR is still in draft; only after the operator approves does the agent
clear draft and engage the rest of the team publicly. The lifecycle stages are
named by **PR visibility**, not audience: `private_review_*` happens while the
PR is still in draft; `public_review_*` happens after draft is cleared. The
audience of each is mode-dependent — in solo mode the operator IS the public
reviewer; in team mode the operator is the private reviewer and the team is
the public one.

## Why worktrees

Git worktrees let the agent keep a dedicated checkout for its branch without
disturbing the user's main checkout or other branches. Without them, an agent
editing files in the user's primary worktree would conflict with any concurrent
work the user is doing, and two agent sessions on different features would
conflict with each other.

The protocol requires the agent to be in a dedicated worktree before making any
changes, but leaves the creation mechanism open. If the agent is already invoked
inside a suitable worktree, creating a new one would be redundant. What matters
is the property — isolation — not the ceremony.

## Why an empty commit opens the PR

Opening the PR against an empty commit (with `[skip ci]`) rather than against the
first real commit avoids a common trap: CI runs against a half-finished
implementation and the PR starts its lifecycle in a red state for reasons
unrelated to the final code — and wastes CI capacity on code we know can't work
yet.

The empty commit is also a stable detection marker: the `[skip ci]` message at
the base of the PR branch identifies agent-authored PRs without requiring a
separate metadata store.

## Why the plan lives in a comment, not the PR body

The PR body (Motivation, Ticket link, Test plan) is written for human readers
who want a stable description of the work. It shouldn't churn as the agent
revises its approach.

The pinned plan comment is the agent's working document. It gets updated as steps
are checked off, new steps discovered, and some approaches abandoned. Keeping
these two documents separate means a reader consulting the PR body weeks later
still gets a coherent description, while the plan comment shows the full evolution
of the work.

## Automation-first reviewer progression

The protocol enforces an ordering: Copilot before humans. Automated review is
cheap, fast, and scalable; running it first filters the defects it catches well
(bugs, style, obvious oversights) so human reviewers can focus on the judgment
calls it cannot answer (architecture, product decisions, organizational context).

The CI gate before each handoff serves the same purpose: there's no point asking
a reviewer — automated or human — to look at code that doesn't compile or whose
tests are failing.

## Why a private review stage (team mode)

In a team repo, clearing draft is a public act — it announces "this is ready
for the team to look at." If the operator only sees the change after the team
does, the operator's feedback can't shape the framing the team encounters.

The private review stage gives the operator first look while the PR is still
in draft. The agent engages the operator (via PR review request in Mode A, or
ticket/out-of-band channel in Mode B) and waits for an approval signal — a
formal review approval, a `+1` reaction on the engagement comment, a "go
ahead" / "lgtm" text reply, or a ticket-side approval. Only then does the
agent clear draft and engage the rest of the team.

In solo mode the operator IS the only human reviewer, so this stage adds
nothing — the agent skips it and engages the operator publicly. The lifecycle
diagram is unchanged in shape; only the edge out of Copilot differs by mode.

## Pre-push review

Before pushing significant changes, the agent runs an adversarial review: a
pass by a reviewer structurally separate from the author, examining the change
for defects and missed cases. The same reasoning process should not both
produce and approve a change. A different model family is the strongest form
of separation; a different agent role on the same model is a weaker fallback.

Findings must be triaged before the push lands. "Triaged" means either acted on
or explicitly dismissed with a recorded rationale. Silently ignoring a finding
is not triaging it.

## Monitoring and termination

After reaching a steady state — plan complete, no actionable threads, review
requested — the agent doesn't exit. New activity can arrive at any point: a CI
flake, a reviewer comment, a security annotation. The agent stays present and
responds until the PR closes or the operator explicitly tells it to stop.

The termination signal is closure, not completion. "My plan is checked off" is not
a reason to stop monitoring.
