# §2.4.1 — Delivery Protocol: Narrative

## Design goals

The Delivery Protocol exists to ensure three things hold whenever an agent
changes code:

1. **Agents don't pollute the main worktree.** The operator's primary checkout
   stays clean. Agent work happens in isolated worktrees so concurrent sessions
   don't step on each other or on the operator.

2. **Work goes through the appropriate quality gates.** Every change passes
   pre-push review, CI, and the reviewer-progression stages in a uniform order.
   Nothing reaches a human reviewer that hasn't already been examined by the
   available automation.

3. **Human reviewers are not engaged while automation is still in play.** The
   protocol holds human review until automated signals (CI, Copilot,
   adversarial pre-push review) have done their work. Human reviewers only see
   PRs whose remaining questions genuinely require human judgment.

## Stage overview

Work flows through these stages:

```
Solo mode (default):
  Worktree setup → PR open → Implementation → Pre-push review → CI + Copilot →
    Ready for review (draft cleared) → Operator review → Termination

Team mode:
  Worktree setup → PR open → Implementation → Pre-push review → CI + Copilot →
    Operator pre-review (in draft) → Ready for review (draft cleared) →
      Team review → Termination
```

Each stage has a precondition (what must be true before entering it) and a
postcondition (what the agent emits or achieves before leaving it). The stages
are not strictly sequential — implementation and CI may interleave, and
iteration loops back from any review stage to implementation — but the overall
direction is left-to-right.

The shape is selected by the `team_mode` config flag. In **solo mode** the
operator is the only human reviewer; the agent marks the PR ready for review
after Copilot, and the operator reviews like a normal team member (post-draft).
In **team mode** the operator is one of several human reviewers, and they get
a private pre-review pass while the PR is still in draft — they're the agent's
principal and bear the consequences of what gets shipped, so it's appropriate
for them to see the result before it's announced to the rest of the team. The
agent clears draft only after the operator approves; the rest of the team is
engaged after that.

## Why worktrees

Git worktrees let the agent keep a dedicated checkout for its branch without
disturbing the operator's main checkout or other branches. Without them, an
agent editing files in the operator's primary worktree would conflict with any
concurrent work the operator is doing, and two agent sessions on different
features would conflict with each other.

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

The protocol enforces an ordering: Copilot before any human. Automated review
is cheap, fast, and scalable; running it first filters the defects it catches
well (bugs, style, obvious oversights) so human reviewers can focus on the
judgment calls it cannot answer (architecture, product decisions,
organizational context).

In **solo mode** there are no other humans — the operator performs the role
the team would otherwise perform. After Copilot the agent marks the PR ready
for review and the operator reviews the (now non-draft) PR like a normal
reviewer. There is no private in-draft operator pass; it would be redundant.

In **team mode** the operator is one of several humans and gets a private
pre-review while the PR is still in draft. The operator is the agent's
principal — they're who decided the work was worth doing and they bear the
consequences of what gets shipped — so it's appropriate for them to see the
result before it's announced to the rest of the team. The agent only clears
draft after the operator approves; the rest of the team is engaged after that.

The CI gate before each handoff serves the same purpose: there's no point asking
a reviewer — automated or human — to look at code that doesn't compile or whose
tests are failing.

## Pre-push review

Before pushing significant changes, the agent runs two reviews:

1. **Self-simplification** — looks for opportunities to reduce complexity,
   consolidate with existing code, or remove unnecessary additions.

2. **Adversarial review** — a pass by a distinct reviewer (a different model, a
   different agent role) that examines the change for defects and missed cases.
   The same reasoning process should not both produce and approve a change; the
   adversarial reviewer is structurally separate from the author.

Both findings must be triaged before the push lands. "Triaged" means either acted
on or explicitly dismissed with a recorded rationale. Silently ignoring a finding
is not triaging it.

## Monitoring and termination

After reaching a steady state — plan complete, no actionable threads, review
requested — the agent doesn't exit. New activity can arrive at any point: a CI
flake, a reviewer comment, a security annotation. The agent stays present and
responds until the PR closes or the operator explicitly tells it to stop.

The termination signal is closure, not completion. "My plan is checked off" is not
a reason to stop monitoring.
