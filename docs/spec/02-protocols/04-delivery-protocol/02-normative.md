# §2.4.2 — Delivery Protocol: Normative

## Applicability

### Default

Every repository is assumed PR-driven unless declared otherwise. This protocol
applies to any code change in a PR-driven repository, whether or not the change
is linked to a ticket.

### Opt-out

A repository's `CLAUDE.md` (or equivalent durable instruction file) MAY declare
the repository non-PR-driven. When a repository is declared non-PR-driven, this
protocol does not apply and the agent commits directly to the default branch per
the repository's own conventions.

### No-CI repositories

If a repository has no CI system configured, CI gates defined below are treated
as if green. The rest of the protocol — worktree isolation, PR-open sequence,
pre-push review, reviewer progression, monitoring, termination — still applies.
The agent MUST NOT fabricate check runs.

### Platform scope

This version covers GitHub (github.com and GitHub Enterprise). On some GitHub
Enterprise installations Copilot review is unavailable; where Copilot review is
unavailable, Stage 1 is skipped per §Stage 1 below.

## Worktree

### Requirement

The agent MUST be operating inside a git worktree dedicated to the current work
before making any code changes. The requirement is already satisfied when:

- The agent is already in a worktree created for this work (resumed session, or
  user-invoked inside one).
- The repository is single-branch-only and worktree isolation provides no
  meaningful benefit.

When neither applies, the agent MUST create a dedicated worktree before
proceeding.

### Path convention

The default path for a new worktree is:

```
~/.worktrees/<owner>/<repo>/<branch>
```

Any local context (`CLAUDE.md` or equivalent durable instruction file in the
repository or user's home directory) MAY override this location. The agent MUST
locate existing worktrees via `git worktree list`, not by path guessing.

### Reuse and cleanup

When resuming work on a branch that already has a worktree, the agent MUST reuse
that worktree. Multiple worktrees on the same branch are forbidden.

When the PR closes (merged or otherwise), the agent MUST remove any worktree it
created for that PR. Worktrees not created by the agent MUST be left alone.

## PR-open sequence

### Step 1 — Empty commit

Before any real work, the agent MUST create an empty commit on the work branch
with this exact message:

```
chore: open PR [skip ci]
```

The agent MUST NOT amend or squash this commit for the life of the PR.

### Step 2 — Draft PR

The agent MUST push the work branch and open a draft pull request. The PR body
MUST contain, in this order:

1. **Motivation** — why the work is being done; user-facing problem statement
   and expected outcome.
2. **Ticket link** — a clickable link to the tracked ticket, if one exists.
   Omitted entirely when no ticket exists. Bare IDs are non-conforming.
3. **Test plan** — how the change will be verified; concrete commands, scenarios,
   and expected outcomes.

The PR body MUST NOT contain the execution plan. The PR MUST be opened in draft
state.

### Step 3 — Pinned plan comment

Immediately after opening the PR, the agent MUST post the execution plan as a
top-level comment. The comment MUST follow §2.1 (machine marker, Mode B sparkle
wrapper where required).

The comment MUST be findable for later editing. The agent MUST embed a
plan-specific sentinel in the comment body:

```
<!-- agent-plan:<agent-id> -->
```

The sentinel MUST appear inside the wrapped body (after the opening sparkle line
in Mode B, or after the machine marker in Mode A) so the §2.1 wire format is
preserved. It MUST NOT appear as a leading marker displacing the machine marker.

If the platform supports comment pinning, the agent SHOULD also pin the comment.

## Resuming on an existing PR

When an open PR already exists for the assigned work, the agent MUST reuse it:

- Reuse the existing worktree per §Worktree.
- Skip Steps 1–3 of the PR-open sequence.
- Locate the existing plan comment by the `<!-- agent-plan:<agent-id> -->` marker
  and treat it as the live plan.

If no plan comment exists on the resumed PR, the agent MUST post one before
resuming work. The PR body MUST NOT be retroactively rewritten.

The agent MUST NOT open a second PR for work that already has an open PR. A new
PR is permitted only when the prior PR was closed without merging.

## Implementation phase

### Plan updates

As work progresses, the agent MUST keep the plan comment current by editing it
in place. Completed steps SHOULD be checked off. Abandoned steps SHOULD be struck
through with a one-line rationale, not deleted. New steps SHOULD be appended.

The PR body's Motivation and Test Plan sections SHOULD remain stable.
Substantive scope changes belong in the plan comment, accompanied by a
`TRANSITION` log entry per §2.3 if a ticket exists.

### Reviewer responses

Whenever a reviewer (operator, human teammate, Copilot, or any other commenter) leaves a comment,
the agent MUST respond per §2.1 — terminal reaction or text token where
applicable, plus an explanatory reply where the comment is substantive.

Every substantive reply MUST state either:

- **What changed** — a brief description of the code change made in response,
  with a link to the specific commit or commit range that implements it, OR
- **Why the comment was dismissed** — a one-or-two-sentence rationale for not
  acting on it.

A reply that does neither is non-conforming.

## Pre-push review

Before pushing a **significant** change, the agent MUST run both reviews below
and triage their findings before the push lands.

### What counts as significant

A push is significant when it contains substantive edits that affect behavior,
structure, interface, or the substance of documentation. The following are NOT
significant:

- The `chore: open PR [skip ci]` empty commit.
- Pushes containing only inline code comments or whitespace/formatting changes.
- Pushes containing only trivial fixups (typo corrections, one-line lint fixes).

If the agent cannot definitively classify a push as non-significant, it MUST
treat it as significant.

### Required reviews

1. **Self-simplification review.** A pass examining the pending change for
   opportunities to simplify, consolidate with existing code, or remove
   unnecessary complexity. The `simplify` skill satisfies this requirement; an
   equivalent local convention is acceptable.

2. **Adversarial review by a distinct reviewer.** A pass by a reviewer that is
   NOT the agent producing the change — typically a different model or a
   different agent role — examining the change for defects, missed cases, and
   incorrect assumptions. The same reasoning process MUST NOT both produce and
   approve the change.

### Local overrides

If the repository's `CLAUDE.md` recommends specific pre-push review steps serving
the same roles, those steps replace the corresponding required reviews above. The
agent MUST still run two reviews (one self-simplification, one adversarial); local
guidance chooses the concrete tools.

### Triage requirement

For each finding from either review, the agent MUST either:

- **Act on it** — amend the pending change to address the finding before pushing,
  OR
- **Dismiss it** — record a one-line rationale (in the commit message body, an
  appended note on the plan comment, or another auditable venue) for why the
  finding does not apply.

Triage is complete when every surfaced finding has either been acted on
(evidenced by the amended change) or dismissed with a recorded rationale.
Silently ignoring a finding is non-conforming. Pushing before triage is complete
is non-conforming.

## CI gates and reviewer progression

### Mode selection: solo vs team

The reviewer progression has two shapes selected at session start by an
implementation-defined `team_mode` flag (e.g. a per-plugin userConfig
setting, a `CLAUDE.md` directive). The default is **solo mode**.

- **Solo mode** (`team_mode = false`). The operator is the sole human
  reviewer. Stage 3 (team review) is skipped entirely. After operator
  approval, the agent goes directly to merge.
- **Team mode** (`team_mode = true`). Additional human reviewers exist
  beyond the operator. The operator gets a private pass over the PR while
  it is still in draft (Stage 2); draft is cleared only after operator
  approval; the rest of the team is engaged in Stage 3.

Stages 1 and 2 run in both modes. Stage 3 runs only in team mode.

### Stage 1 — Draft → Copilot review

Once BOTH of the following hold, the agent MUST request Copilot review:

1. The agent is confident the changes are ready for review.
2. The current PR head has achieved a green CI rollup at least once since the
   agent reached that confidence point ("first green"). Earlier green rollups on
   intermediate commits do not satisfy this condition.

If Copilot review is unavailable in the current GitHub installation, Stage 1 is
skipped and the agent proceeds directly to the Stage 2 gating condition.

### Stage 2 — Copilot review → Operator review (in draft)

Once ALL of the following hold, the agent MUST engage the operator for a
review pass:

1. The current PR head has a green CI rollup.
2. No Copilot thread on the PR is actionable per §2.2.
3. The PR is still in draft state. The agent MUST NOT clear draft before
   this stage.

When Stage 1 was skipped, condition 2 is trivially satisfied.

**Identifying the operator.** There is at most one operator per session. In
Mode A (the agent runs under a dedicated bot/service account distinct from
its operator), the operator is identified by an explicit configuration value
(e.g. an `operator_login` setting, the ticket assigner, or per-repo config);
the selection mechanism is implementation-defined. In Mode B (the agent
shares platform credentials with its operator), the operator is the
authenticated account.

**Engagement venue.** The agent MUST reach the operator through the first
venue that can deliver a notification:

1. **Mode A**: a GitHub PR review request on the draft PR, addressed to the
   operator's account. The request fires a normal notification because the
   operator's account is distinct from the agent's.
2. **Mode B**: GitHub's review-request mechanism cannot target the
   authenticated account, so the agent MUST instead engage the operator
   through one of:
   1. A ticket comment on the associated tracker (Linear, Asana, GitHub
      Issues) tagging the operator. Because the operator has a separate
      account on the tracker, platform notifications fire normally.
   2. An implementation-defined out-of-band channel (Slack, email, etc.)
      specified in the repository or user configuration.

   In long-running automated sessions, venue 2.1 is preferred.

**Iteration in draft.** Stage 2 iterates: the operator may leave comments
(actionable per §2.2) and the agent MUST address them per §Reviewer
responses. The PR remains in draft for the duration. The stage completes
when the operator signals approval — a formal approval review (Mode A
only), a `+1` reaction on the engagement comment, a "go ahead" reply, or
an explicit "ready/clear draft" instruction.

**Draft clearance.** On operator approval the agent MUST clear draft state.
The operator MAY clear draft themselves; in that case the agent observes
the cleared state and treats it as equivalent to operator approval — the
stage completes without the agent acting on draft.

### Stage 3 — Operator review → Team review (team mode only)

In solo mode, Stage 3 is skipped entirely; after Stage 2 the agent proceeds
to merge.

In team mode, once ALL of the following hold, the agent MUST request team
review:

1. The current PR head has a green CI rollup.
2. No operator thread on the PR is actionable per §2.2.
3. The PR is marked ready for review (draft state cleared).

**Identifying team reviewers.** The agent MUST identify a specific human or
set of humans to engage, excluding itself and the operator. The selection
mechanism (CODEOWNERS, ticket-derived reviewer set, per-repo config) is
implementation-defined.

**Engagement venue.** The agent MUST follow §2.1 rules on alternative
credentials if the platform restricts which accounts may request which
review types. In Mode B the operator's credentials cannot be used to
request review from the operator; the engagement venue rules from Stage 2
apply for any reviewer that cannot be reached via a GitHub review request.

### Stage 4 — Iteration

Once review is requested (Copilot, operator, or team), the agent MUST
continue iterating. New comments and CI failures MUST trigger responses per
§Reviewer responses and §Pre-push review. The iteration loop is driven by
actionability per §2.2: the agent iterates as long as any thread or
annotation on the PR is actionable and stops when none is.

The agent MAY dismiss automated reviewer comments that are not material to
the change, per the reviewer-responses rule. The agent SHOULD give human
comments more deference than automated ones; the bar to dismiss a human
comment is higher. Operator comments carry the highest deference — the bar
to dismiss an operator comment is higher than for any other reviewer.

## Monitoring

After catching up with the current PR state and reaching a quiescent point, the
agent MUST continue monitoring the PR for new activity. Monitored events include
at minimum:

- CI run failures on the current head.
- New top-level PR comments.
- New inline review threads or replies to existing threads.
- New automated annotations (code scanning, security alerts, linter outputs).

Detection follows §2.2 and §2.1. Whether the agent uses event subscription,
polling, or another mechanism is implementation-defined.

While monitoring, the agent MUST emit `INFO` heartbeats per §2.3 operational
logging so observers can confirm the agent is alive. Sessions with no linked
ticket use `ticket=-` in the log format.

## Termination

The Delivery Protocol terminates — the agent stops monitoring and exits — when
EITHER of the following occurs:

- **PR closes.** The PR is merged or closed without merging.
- **Operator explicitly instructs the agent to stop.** The operator leaves an
  instruction in the PR or ticket telling the agent to disengage. The agent
  MUST acknowledge the instruction per §2.1 and exit.

The agent MUST NOT stop monitoring solely because:

- Its plan is fully checked off.
- CI is green.
- Review was requested.

Until a termination condition is met, the agent MUST remain monitoring.
