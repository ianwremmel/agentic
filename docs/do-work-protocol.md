# Do-Work Protocol

This document defines the on-the-wire behavior any agent MUST
follow when it changes code in a repository governed by a
pull-request workflow. It is a protocol specification, not an
implementation guide: it describes the artifacts an agent emits
(worktree, empty commit, draft PR, pinned plan, reviewer
requests), the order they appear in, and the conditions that
gate progress between stages. It stays silent on skill
choreography, the agent's operational driver, and the specific
API calls used to produce each artifact.

Read alongside `agent-communication-protocol.md` (how to write
into a comment stream), `pr-status-protocol.md` (how to read PR
state), and `ticket-workflow-protocol.md` (how state on a
tracked ticket maps onto an abstract lifecycle). Those three
protocols stay authoritative for their concerns; this one
references them rather than duplicating.

## Why this exists

Whenever an agent changes code in a repository, the act of
doing so produces side effects that other humans and agents
must be able to observe and respond to: a branch, a pull
request, a review request, comments responding to reviewers,
state changes on a linked ticket. Without a shared protocol,
every skill that touches code re-invents these side effects in
slightly different ways — different branch layouts, different
PR-open ceremonies, different rules about when to ask for
review — and the audit trail becomes unreadable.

This protocol fixes those side effects to a uniform shape. Any
agent doing code work in a PR-driven repository produces the
same artifacts in the same order, gated by the same conditions,
so a human (or another agent) auditing a PR can tell at a
glance what stage the work is at and what is expected to
happen next.

## Scope

The protocol covers:

- the detection rule that turns the protocol on or off for a
  given repository
- the worktree requirement and its path convention
- the PR-open sequence (empty commit, draft PR body, pinned
  plan comment)
- the resume rule for an existing PR
- the rules governing plan updates and reviewer responses
- the pre-push review requirement for significant changes
- the gating conditions between CI, Copilot review, and human
  review
- the monitoring requirement after the agent steps back
- the termination condition for the protocol

It does not cover:

- skill choreography (which sub-steps to run, how to verify, how
  to triage a failed CI run)
- the agent's operational driver (event subscription, polling
  loop, etc.)
- the branch naming convention (per-repo or per-skill concern)
- the commit message convention for real work commits
  (per-repo concern)
- non-GitHub PR platforms (GitLab, Gitea, Bitbucket, Gerrit are
  out of scope for now; the protocol may be extended later)

## Applicability

### Default

Every repository is assumed PR-driven unless declared
otherwise. The protocol applies to any code change in such a
repository, whether or not the change is linked to a ticket.

### Opt-out

A repository's `CLAUDE.md` (or equivalent durable instruction
file) MAY declare the repository non-PR-driven. The canonical
example is a GitOps repository where the only path to
production is pushing to the default branch and observing
results; pull requests are not part of the evaluation loop.
When a repository is declared non-PR-driven, this protocol does
not apply and the agent commits directly to the default
branch per the repository's own conventions.

### No-CI repositories

If a repository has no continuous-integration system
configured, this protocol does not apply. The CI gates defined
below are load-bearing; an agent cannot satisfy them in a repo
where no check rollup exists. Such repositories MUST either
configure CI, declare themselves non-PR-driven, or accept that
the do-work protocol is a no-op for them.

### Platform

This version of the protocol covers GitHub (both github.com and
GitHub Enterprise installations). Behavioral differences
between the two are called out where they exist; the most
notable is that Copilot review may be unavailable on
Enterprise, in which case the Copilot stage is skipped.

## Worktree

### Requirement

Before making any code change, the agent MUST be operating
inside a git worktree dedicated to the work it is about to do.
The intent is to isolate the agent's edits from the user's
main checkout and from any other concurrent agent work.

The requirement is satisfied if either of the following holds:

- The agent is already in a worktree created for this work
  (e.g. resumed from a prior session).
- The repository is a single-branch-only repository where
  worktrees do not provide isolation (no other branches exist
  and none are expected).

Otherwise the agent MUST create a worktree before proceeding.

### Path convention

New worktrees MUST be created under:

```
~/.worktree/<owner>/<repo>/<branch>-<random>
```

- `<owner>` and `<repo>` are taken from the repository's origin
  URL.
- `<branch>` is the branch name the worktree checks out.
- `<random>` is a short random suffix (4–8 characters) that
  disambiguates concurrent worktrees on the same branch and
  makes the path unique even if the same branch is checked out
  twice across sessions.

The random suffix means there is no deterministic path to a
worktree. Agents that need to find an existing worktree for a
branch MUST consult `git worktree list` rather than guessing
the path.

### Reuse and cleanup

When the agent resumes work on a branch that already has a
worktree under the convention above, it MUST reuse that
worktree rather than creating a new one. Multiple worktrees on
the same branch are forbidden.

Cleanup is implementation-defined. The protocol does not
require the worktree to be removed when the PR closes, but
skills SHOULD prune stale worktrees as a housekeeping concern.

## PR-open sequence

### Step 1 — Empty commit

Before any real work, the agent MUST create an empty commit on
the work branch with this exact message:

```
chore: open PR [skip ci]
```

The `[skip ci]` token suppresses CI on the empty commit so the
PR does not open against a meaningless red rollup. The empty
commit MUST be preserved for the life of the PR; the agent MUST
NOT amend or squash it locally. Whether it survives merge is
the repository's merge-strategy concern, not the agent's.

The empty commit is the protocol's load-bearing marker that the
PR was opened by an agent following this protocol. Tooling MAY
rely on its presence and exact message to detect protocol-
governed PRs.

### Step 2 — Draft PR

The agent MUST push the work branch and open a draft pull
request against the repository's default branch. The PR body
MUST contain, at minimum, these three sections in this order:

1. **Motivation** — why the work is being done. User-facing
   problem statement, expected outcome.
2. **Ticket link** — if the work is linked to a tracked
   ticket, a clickable link to that ticket per
   `ticket-workflow-protocol.md`'s rule that no ticket may be
   referenced by bare ID. Omitted entirely when no ticket
   exists.
3. **Test plan** — how the change will be verified. Concrete
   commands to run, scenarios to exercise, expected outcomes.

The PR body MUST NOT contain the execution plan; that lives in
the pinned plan comment (next step). Splitting the two prevents
the body from churning every time the plan evolves.

The PR MUST be opened in draft state. Promotion to
ready-for-review happens later in the sequence, gated on the
review-progression rules below.

### Step 3 — Pinned plan comment

Immediately after opening the PR, the agent MUST post the
execution plan as a top-level comment on the PR. The plan is a
checklist of the steps the agent intends to execute,
sufficient for a human to audit the agent's intended scope at a
glance.

**Identification.** The comment MUST be findable for later
editing. If the platform supports comment pinning (or an
equivalent first-class "highlight this comment" mechanism), the
agent MUST pin it. On platforms without pinning — GitHub PR
comments included — the agent MUST embed a plan-specific
machine marker in the comment body in addition to the standard
agent-reply marker from `agent-communication-protocol.md`:

```
<!-- agent-plan:<agent-id> -->
```

The plan marker is a distinct sentinel from `agent-reply`; both
appear on the plan comment (one identifies it as agent-
authored, the other identifies it as the plan).

**Framing.** The comment body itself follows
`agent-communication-protocol.md` end-to-end — machine marker
plus mode-appropriate sparkle wrap.

## Resuming on an existing PR

If, at the start of a work session, an open PR already exists
for the work the agent has been assigned (matching branch,
matching tracked ticket, or the user explicitly points at an
existing PR), the agent MUST reuse it. Specifically:

- Reuse the existing worktree (per "Reuse and cleanup" above).
- Skip Steps 1–3 of the PR-open sequence.
- Locate the existing pinned plan comment by the
  `agent-plan:<agent-id>` marker (or platform pin) and treat it
  as the live plan going forward.

If no pinned plan comment exists on the resumed PR — e.g. the
PR was opened by a tool that does not follow this protocol —
the agent MUST post one as in Step 3 before resuming work. The
PR body is not retroactively rewritten.

The agent MUST NOT open a second PR for work that already has
an open PR. If a prior PR was closed without merging, opening a
new PR is permitted.

## Implementation phase

### Plan updates

As work progresses, the agent MUST keep the pinned plan comment
current by editing it in place. New steps SHOULD be appended;
completed steps SHOULD be checked off; abandoned steps SHOULD
be struck through with a one-line rationale rather than
deleted, so the edit history reflects what was tried.

The plan comment is the canonical source of truth for the
agent's intended scope. The PR body's Motivation and Test Plan
sections SHOULD remain stable; substantive changes to scope or
verification belong in the plan comment with a state-change log
entry per `ticket-workflow-protocol.md`'s operational logging
rules, if a ticket exists.

### Reviewer responses

Whenever a reviewer (human, Copilot, or any other commenter)
leaves a comment, the agent MUST respond per
`agent-communication-protocol.md` — terminal reaction or
text token where applicable, plus an explanatory reply where
the comment is substantive.

This protocol adds one requirement on top of the inherited
rules: every substantive reply MUST state either

- **what changed** — a brief description of the code change
  the agent made in response, accompanied by a link to the
  specific commit (or commit range) that implements the change,
  OR
- **why the comment was dismissed** — a one-or-two-sentence
  rationale for not acting on the comment.

A reply that does neither is non-conforming. The intent is to
make every review iteration auditable: a reader scanning the
thread can tell, for each reviewer comment, what the agent did
and where to verify it.

## Pre-push review

Before pushing a commit that contains **significant** changes,
the agent MUST run two pre-push reviews and triage their
findings before the push lands.

### What counts as "significant"

A push is significant when it contains substantive code edits
— changes that affect behavior, structure, or interface. The
following pushes are NOT significant and are exempt from
pre-push review:

- The empty `chore: open PR [skip ci]` commit from PR-open
  step 1.
- Pushes containing only documentation, comments, or
  formatting changes.
- Pushes containing only trivial fixups — typo corrections, a
  one-line lint fix, etc.

The agent uses judgment on borderline cases. The default on
uncertainty is to run the reviews.

### Required reviews

The agent MUST run both of:

1. **Self-simplification review.** A pass that looks at the
   pending change for opportunities to simplify, consolidate
   with existing code, or remove unnecessary complexity. The
   canonical implementation is the `simplify` skill; an
   equivalent local convention satisfies the requirement.
2. **Adversarial review by a distinct reviewer.** A pass by a
   reviewer that is **not** the agent producing the change —
   typically a different model or a different agent role —
   examining the change for defects, missed cases, and
   incorrect assumptions. The canonical pattern is invoking a
   Codex-based review; any equivalent cross-reviewer pattern
   satisfies the requirement. The intent is that the same
   reasoning process does not both produce and approve the
   change.

### Local overrides

If the repository's `CLAUDE.md` (or equivalent durable
instruction file) recommends specific pre-push review steps
that serve the same role — e.g. a project-specific linter, a
mandatory test suite, a team-specified review skill — those
steps replace the corresponding required review above. The
agent MUST still run two reviews in the spirit defined here
(one self-simplification, one adversarial); local guidance
chooses the concrete tools.

### Triage requirement

Findings from either review MUST be triaged before the push
lands. For each finding the agent either:

- **Acts on it** — amends the pending change to address the
  finding before pushing, OR
- **Dismisses it** — records a one-line rationale (in the
  commit message body, a note appended to the pinned plan
  comment, or another auditable venue) for why the finding
  does not apply.

Silently ignoring a finding is non-conforming. Pushing without
having triaged at least the surfaced findings is non-
conforming. The agent MAY choose to address findings in
follow-up commits within the same push, but the choice MUST be
explicit and recorded.

## CI gates and reviewer progression

The agent advances the PR through three stages: draft, Copilot
review (when available), and human review. Each stage has a
gating condition.

### Stage 1 — Draft → Copilot review

The agent MAY request Copilot review when both of the following
hold:

1. The agent is confident the changes are ready for review
   (implementation complete enough that further iteration is
   expected to be small).
2. The current PR head has achieved a green CI rollup at least
   once since the agent reached the confidence point above
   ("first green").

"First green" is measured from the agent's confidence point
forward — earlier green rollups on intermediate commits do not
count. The intent is that Copilot reviews a state of the code
the agent has actually proposed for review, not a transient
snapshot.

Copilot review and CI may run concurrently after the gate is
satisfied; the agent does not need to wait for a second green
before requesting Copilot.

If Copilot review is unavailable in the current GitHub
installation (most commonly on GitHub Enterprise), Stage 1 is
skipped entirely and the agent proceeds directly from draft to
Stage 2's gating condition.

### Stage 2 — Copilot review → Human review

The agent MAY request human review when all of the following
hold:

1. The current PR head has a green CI rollup.
2. No Copilot thread on the PR is actionable per
   `pr-status-protocol.md`'s actionability rules.
3. The PR is marked ready for review (draft state cleared).

When Copilot was skipped (Stage 1 unavailable), condition 2 is
trivially satisfied.

**Identifying the human.** The specific human to request is
repo-dependent. The protocol does not prescribe a selection
mechanism; CODEOWNERS, ticket assigner, configured per-repo
reviewer, or another convention may all be acceptable. The
agent MUST identify a specific human (or set of humans) to
request, MUST NOT request review from itself, and MUST follow
`agent-communication-protocol.md`'s rules on alternative
credentials if the platform restricts who may request which
kinds of review.

### Stage 3 — Iteration

Once review is requested (Copilot or human), the agent
continues to iterate. New comments and CI failures trigger
fixes; each fix is responded to per the reviewer-responses rule
above. The iteration loop is **driven by actionability** — the
agent continues iterating as long as any thread or annotation
on the PR is actionable per `pr-status-protocol.md`, and stops
iterating when none is.

The protocol does not cap iteration count or impose a deadline.

## Monitoring

After the agent has caught up with the current state of the PR
and has nothing immediate to do, it MUST continue monitoring
the PR for new activity. The activity set includes at minimum:

- CI run failures on the current head.
- New top-level PR comments.
- New inline review threads or replies to existing threads.
- New automated annotations (code scanning, security alerts,
  linter outputs surfaced as PR annotations).

Detection of these events is the read-side concern of
`pr-status-protocol.md` and `agent-communication-protocol.md`;
this protocol only mandates that the agent react to them.
Whether the agent reacts via event subscription, polling, or
another mechanism is implementation-defined.

The monitoring agent is the same agent that did the work; the
protocol does not require a separate watcher process.

While monitoring, the agent MUST emit heartbeats per
`ticket-workflow-protocol.md`'s operational-logging rules so
that an observer can confirm the agent is still alive. Sessions
with no ticket emit heartbeats with `ticket=-` in the log
format.

## Termination

The do-work protocol terminates — the agent stops monitoring
and exits its work session — when either of the following
occurs:

- **PR closes.** The PR is merged or closed without merging.
  Closure is the canonical signal that the work is no longer in
  flight from the PR's perspective. The ticket side (if a
  ticket exists) may still have a `delivered → verified`
  transition outstanding; that is the ticket-workflow
  protocol's concern, not this one's.
- **Human explicitly tells the agent to stop.** A human
  reviewer or assigner leaves an instruction in the PR (or
  ticket) telling the agent to disengage. The agent MUST
  acknowledge the instruction per
  `agent-communication-protocol.md` and exit.

Until one of these conditions is met, the agent MUST NOT stop
monitoring on its own. In particular: the agent does not stop
monitoring just because its plan is checked off, just because
CI is green, or just because review was requested. New activity
can arrive at any of those points and is the agent's
responsibility.

## Cross-references

- `agent-communication-protocol.md` — comment-stream wire
  format, mode detection, terminal signals, thread-aware
  filtering.
- `pr-status-protocol.md` — PR state retrieval, actionability
  classification, summary cache.
- `ticket-workflow-protocol.md` — abstract role/group
  vocabulary, state transitions, operational logging,
  communication restriction, decomposition rule.
