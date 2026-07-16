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

```text
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

```text
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

```text
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

Whenever a reviewer (human, Copilot, or any other commenter) leaves a comment,
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

### Required review

Before any significant push the agent MUST run an **adversarial review** — a
pass by a reviewer that is NOT the agent producing the change, examining the
change for defects, missed cases, and incorrect assumptions. The same
reasoning process MUST NOT both produce and approve the change.

The reviewer SHOULD be a different model family from the authoring agent
wherever the installation has one configured; a different agent role on the
same model is a weaker fallback, permitted only when no distinct model family
is available.

### Local overrides

If the repository's `CLAUDE.md` recommends specific pre-push review steps,
those steps replace the requirement above. The agent MUST still run an
adversarial review; local guidance chooses the concrete tools and framings.

### Triage requirement

For each finding from the review, the agent MUST either:

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

### Stage 1 — Draft → Copilot review

Once BOTH of the following hold, the agent MUST request Copilot review:

1. The agent is confident the changes are ready for review.
2. The current PR head has achieved a green CI rollup at least once since the
   agent reached that confidence point ("first green"). Earlier green rollups on
   intermediate commits do not satisfy this condition.

If Copilot review is unavailable in the current GitHub installation, Stage 1
is skipped and the agent proceeds directly to the Stage 2 gating condition (or
Stage 3 in solo mode, where Stage 2 is also skipped).

### Mode selection: solo vs team

The Delivery Protocol supports two delivery shapes selected by a per-installation
`team_mode` configuration value:

- **Solo mode** (default — `team_mode=false`). The operator is the only human
  reviewer. After Copilot, the agent clears draft and engages the operator as
  the public reviewer directly. The private review stage (Stage 2 below) is
  skipped; Stage 3 (Public review) targets the operator.
- **Team mode** (`team_mode=true`). The operator is one of several human
  reviewers. After Copilot, the agent runs Stage 2 (Private review) with the
  PR still in draft, targeting the operator. Only after the operator approves,
  the operator — not the agent — clears draft (the agent MUST NOT); the agent
  then runs Stage 3 (Public review) with the rest of the team — the operator is
  **excluded** from the Stage 3 reviewer set.

Stage names refer to **PR visibility**: Stage 2 happens while the PR is still
in draft (`private_review_*` states); Stage 3 happens after draft is cleared
(`public_review_*` states). Audience falls out of mode, as above.

### Stage 2 — Private review (team mode only, in draft)

Reached when ALL of the following hold:

1. `team_mode=true`.
2. The current PR head has a green CI rollup.
3. No Copilot thread on the PR is actionable per §2.2.
4. The PR is still in draft (NOT cleared).

When `team_mode=false`, Stage 2 is skipped entirely and the agent proceeds
directly to Stage 3 after the same CI/Copilot conditions.

When Stage 1 was skipped (Copilot unavailable), condition 3 is trivially
satisfied.

**Operator engagement.** The agent MUST engage the operator while the PR is
still in draft. Engagement has two parts:

1. A **notification** that reaches the operator through a Mode-appropriate
   venue (below).
2. An **engagement comment** — a top-level PR comment the agent posts carrying
   the §2.1 `<!-- agent-reply:<agent-id> -->` machine marker AND, inside the
   wrapped body (after the marker in Mode A / after the opening sparkle in Mode
   B, never displacing the leading machine marker), the engagement sentinel:

   ```text
   <!-- agent-engagement:<agent-id> -->
   ```

   This comment is the anchor that the operator's reaction- or reply-based
   approval signals (Gate 6 below) are tied back to: a `+1` reaction or a "go
   ahead" reply on this comment counts, surfaced via the `<reactions>` child of
   `<comment>` per §2.2.2. The agent MUST post it regardless of Mode, since the
   formal review request (Mode A) and ticket tag (Mode B) are notifications,
   not PR comments the operator can react to.

   The engagement sentinel marks the comment as an agent artifact so it
   classifies **non-actionable** per §2.2.2 (mirroring the plan comment).
   Without it, the agent's own soliciting comment would carry the
   `agent-reply` marker but no terminal signal and so stay `actionable="true"`
   forever — perpetually failing Gate 4 ("no actionable comments") and blocking
   the draft-clear, public-review, and merge transitions. The agent MUST NOT
   instead terminal-tag the engagement comment: a terminal signal means
   "finished, suppress re-evaluation," which is wrong while the agent is
   actively awaiting operator approval.

The notification venue by Mode:

- **Mode A** (separate agent account). Use the platform's PR review-request
  API, targeting the operator's identity. The operator identity is supplied
  via implementation-defined configuration (see §2.2.2 "Operator identity") and
  is REQUIRED; if no operator is configured the agent MUST fail and ask for one
  to be set, rather than falling back to the ticket assigner.
- **Mode B** (shared credentials). The operator identity IS the authenticated
  (shared) account. The PR review-request API cannot target it, so the agent
  MUST instead engage the operator through the first available venue that can
  reach them, in the same order Stage 3 prescribes for Mode B engagement: a
  ticket comment tagging the operator first, then an implementation-defined
  out-of-band channel.

**Gate 6 — Operator-approved (always required).** Satisfied by ANY of the
following signals on the engagement venue:

- A `<review mode="human" role="operator" state="approved">` element in the
  next pr-status XML (Mode A formal review).
- A `<reaction emoji="+1">` from the operator on the agent's engagement
  comment (surfaced via the `<reactions>` child of `<comment>` per §2.2.2).
- A "go ahead" / "lgtm" / "ready" reply from the operator on
  the engagement comment, on the ticket, or via the out-of-band channel.
- A ticket-side approval signal (e.g. status transition by the operator).

In team mode Gate 6 is satisfied during Stage 2. In solo mode (Stage 2
skipped), Gate 6 is satisfied during Stage 3 via the same signals on the
operator's public-review engagement.

**Draft clearance.** In **solo mode**, the agent clears draft after Copilot
(per Mode selection above) and engages the operator; Gate 6 is then satisfied
during Stage 3. In **team mode**, draft is cleared only after Gate 6 is
satisfied in Stage 2 AND CI/Copilot conditions still hold — and the operator,
**not** the agent, clears it (moving the PR from draft to ready). The agent MUST
NOT clear draft in team mode; it observes the PR is no longer a draft and
proceeds to Stage 3. If the operator clears draft BEFORE Gate 6 is satisfied,
draft clearance alone does NOT satisfy Gate 6: the agent MUST remain in Stage 2,
continue awaiting an operator approval signal (re-engaging if needed), and
advance to Stage 3 only once Gate 6 holds.

### Stage 3 — Public review

Once ALL of the following hold, the agent MUST request public review:

1. The current PR head has a green CI rollup.
2. No Copilot thread on the PR is actionable per §2.2.
3. The PR is marked ready for review (draft state cleared).
4. In team mode: Gate 6 was satisfied in Stage 2 (so draft clearance was
   authorized).

When Stage 1 was skipped, condition 2 is trivially satisfied. When Stage 2 was
skipped (solo mode), condition 4 is trivially satisfied.

**Identifying the reviewer.** The agent MUST identify a specific human
reviewer or set of human reviewers to engage. The selection mechanism
(CODEOWNERS, ticket assigner, per-repo config) is implementation-defined. The
agent MUST NOT request review from itself. The agent MUST follow §2.1 rules
on alternative credentials if the platform restricts which accounts may
request which review types.

In **solo mode** the target is the operator, resolved as in Stage 2: the
configured operator identity in Mode A, or the authenticated account in Mode B —
no ticket-assigner fallback. In **team mode** the operator is
**excluded** from the reviewer set — the operator's binding signal was
collected during Stage 2 via Gate 6; Stage 3 collects the team's binding
signal via Gate 7 below.

**Engagement in Mode B.** When the agent shares credentials with the desired
reviewer (Mode B per §2.1), GitHub's review-request mechanism cannot be used,
and a PR comment tagging the reviewer will not trigger a platform notification
(the agent and reviewer share the same account). The agent MUST instead engage
the reviewer through the first available venue that can reach them:

1. A ticket comment on the associated tracker (Linear, Asana, GitHub Issues)
   tagging the reviewer. Because the reviewer has a separate account on the
   tracker, platform notifications fire normally.
2. An implementation-defined out-of-band channel (Slack, email, etc.)
   specified in the repository or user configuration.

In long-running automated sessions, venue 1 is preferred.

**Gate 7 — Team-approved (team mode only).** At least one
`<review mode="human" role="team" state="approved">` from a non-self reviewer,
and no current `changes_requested` from any reviewer. Satisfied during Stage
3. In solo mode Gate 7 is trivially satisfied (not evaluated) — the binding
public-review signal in solo mode is Gate 6, evaluated against the operator
on the same signals listed in Stage 2.

### Stage 4 — Iteration

Once review is requested (Copilot, operator, or team), the agent MUST continue
iterating. New comments and CI failures MUST trigger responses per §Reviewer
responses and §Pre-push review. The iteration loop is driven by actionability
per §2.2: the agent iterates as long as any thread or annotation on the PR is
actionable and stops when none is.

The agent MAY dismiss automated reviewer comments that are not material to
the change, per the reviewer-responses rule. The agent SHOULD give human
comments more deference than automated ones; the bar to dismiss a human
comment is higher.

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
logging so observers can confirm the agent is alive — each poll tick when
waiting inline, or once per wake when waiting event-driven (woken by scheduled
check-ins or platform events rather than an inline poll loop). An event-driven
agent is silent between wakes by design; it MUST instead record its next
scheduled wake in machine-readable wait state, and observers judge its
liveness by that deadline plus a grace period, never by heartbeat age.
Sessions with no linked ticket use `ticket=-` in the log format.

## Termination

The Delivery Protocol terminates — the agent stops monitoring and exits — when
EITHER of the following occurs:

- **PR closes.** The PR is merged or closed without merging.
- **Operator explicitly instructs the agent to stop.** The operator leaves an
  instruction in the PR or ticket telling the agent to disengage. The agent MUST
  acknowledge the instruction per §2.1 and exit.

The agent MUST NOT stop monitoring solely because:

- Its plan is fully checked off.
- CI is green.
- Review was requested.

Until a termination condition is met, the agent MUST remain monitoring.
