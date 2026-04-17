# Milestone Review: Architectural Review, Self-Improvement, and Roadmap Adjustment

After completing a milestone (all issues done/failed/skipped) and before
starting the next one, perform a multi-stage review to ensure architectural
coherence, identify process improvements, and adjust the roadmap.

Skip this review after the LAST milestone — proceed directly to project
completion.

## Stage 0: Post-Merge Review

Before the architectural review, run the post-merge review protocol to ensure
all deferred work from merged PRs has corresponding follow-up tickets.

Load and follow `../../references/post-merge-review.md` with:

- `REPO_OWNER` and `REPO_NAME` from the project variables

This catches any PRs labeled `needs-followup` that were merged during the
milestone. If follow-up tickets are missing, they are created before the
architectural review considers the milestone's technical debt.

If no PRs have the `needs-followup` label, this stage completes immediately with
no action needed.

## Stage 0.5: Sync Main Branch Before Review

Before any review sub-agent reads source files, ensure the local main branch
reflects all merged work from this milestone. The working tree must be clean (no
uncommitted changes) before switching branches. Switch to main explicitly and
use fast-forward-only to avoid accidental merge commits:

```bash
git switch main
git fetch origin main
git merge --ff-only origin/main
```

If `git switch main` fails due to uncommitted changes, stash or commit them
first. If `git merge --ff-only` fails because local main has diverged, reset it
to match the remote: `git reset --hard origin/main`.

This prevents review agents from reading stale local files that do not match
what was actually merged. A later stage (Stage 6) refreshes `origin/main` after
the review for subsequent worktree creation, but this step ensures the review
itself operates on current local code.

## Stage 1: Staff-Engineer Architectural Review

Dispatch a `staff-engineer` sub-agent with:

- **Milestone summary**: List of all PRs merged in this milestone with their
  titles, PR URLs, and a brief description of changes
- **Aggregate diff context**: Run `git log --oneline` on main to see all merged
  commits from this milestone
- **Next milestone preview**: The planned issues for the next milestone with
  their titles and descriptions
- **Source file freshness**: Before reading any source files, run
  `git show origin/main:<path>` to read individual files, or verify the local
  checkout matches `origin/main` by running `git diff origin/main -- <path>`.
  This ensures the review operates on the latest merged code rather than a
  potentially stale local checkout.
- **Review request**: Assess:
    1. Architectural coherence across the merged PRs — do they form a consistent
       foundation?
    2. Any technical debt introduced that should be addressed before the next
       milestone
    3. Whether the codebase is in a clean state for the upcoming work
    4. Concerns about the next milestone's issues given what was built in this
       one
    5. Opportunities to simplify or consolidate before moving forward

Read the sub-agent's output when complete. Store the review findings.

## Stage 2: Pragmatic-PM Roadmap Update

Dispatch a `pragmatic-pm` sub-agent with:

- **Staff-engineer findings**: The full review from Stage 1
- **Project status**: Summary table of all milestones — completed, current,
  remaining — with issue counts and outcomes (done/failed/skipped)
- **Failed items**: Details of any issues that failed in this milestone,
  including the reason for failure
- **Remaining milestones**: The full list of remaining milestones and their
  issues with descriptions
- **Adjustment request**: Recommend:
    1. Whether any failed issues should be retried, moved to a later milestone,
       or dropped
    2. Whether issue priorities within the next milestone should change based on
       what was learned
    3. Whether any new prerequisite issues need to be added to address technical
       debt or architectural concerns from the staff-engineer review
    4. Whether scope of remaining milestones should be adjusted
    5. A brief confidence assessment: is the project on track?

Read the sub-agent's output when complete. Store the recommendations.

## Stage 3: Self-Improvement Review

**Skip condition**: If the just-completed milestone name starts with
`Improvements:`, skip this stage entirely and proceed to Stage 4. This enforces
the depth limit — never create a recursive improvement milestone.

### Data Gathering

Before dispatching the sub-agent, compile concrete data about this milestone's
execution quality:

1. **Extract PR metrics**: For each merged PR in this milestone, read the PR
   body and extract `review_cycles` and `ci_fix_attempts` from the
   `clc-progress` block. Record these values per PR. If the progress block is
   missing or either key is absent, default the value to 0 (consistent with
   backward-compatible handling in the monitoring agent).

2. **Identify high-friction PRs**: Flag any PR where `review_cycles > 2` or
   `ci_fix_attempts > 1`. These indicate repeated mistakes or unclear guidance.

3. **Categorize feedback themes**: For each high-friction PR, fetch Copilot
   feedback by:
   - Inline review comments:
     `gh api repos/$REPO_OWNER/$REPO_NAME/pulls/$PR_NUMBER/comments --paginate`
   - Review bodies:
     `gh api repos/$REPO_OWNER/$REPO_NAME/pulls/$PR_NUMBER/reviews --paginate`
   - Issue comments:
     `gh api repos/$REPO_OWNER/$REPO_NAME/issues/$PR_NUMBER/comments --paginate`

   Filter all three result sets to comments/reviews where the login is a Copilot
   identity, i.e. `user.login` (lowercased) starts with `"copilot"`. This
   covers accounts like `copilot`, `copilot-pull-request-reviewer[bot]`, and
   related variants. Group the remaining Copilot feedback by theme (e.g., type
   errors, missing validation, style violations, architectural issues, test
   gaps). Record the theme and count for each.

4. **Compile aggregate summary**: Produce a summary block containing:
   - Total review cycles across all milestone PRs
   - Total CI fix attempts across all milestone PRs
   - Top 3 feedback themes by frequency (theme name + count)
   - List of high-friction PRs with their cycle/attempt counts
   - CI fix rate: (number of PRs with `ci_fix_attempts > 0`) / (total merged PRs in the milestone)

Pass this compiled data as the `Repeated mistake patterns` input to the
sub-agent dispatch below.

### Dispatch

Dispatch a `staff-engineer` sub-agent with:

- **Milestone review findings** from Stage 1 (architectural review)
- **PM recommendations** from Stage 2 (roadmap update)
- **All memories** created during this milestone (from the project's memory
  directory — the `memory/` subdirectory within the Claude project configuration
  for this repository)
- **Repeated mistake patterns**: the aggregate summary and high-friction PR
  details compiled in the Data Gathering step above

The sub-agent identifies improvements to:

1. Skill files that gave incorrect or incomplete guidance
2. CLAUDE.md instructions that caused confusion or errors
3. Script behavior that needed manual workarounds
4. Documentation gaps discovered during implementation

Each improvement is classified as:

- **Blocking**: Must fix before next milestone (would cause the same errors to
  recur). Examples: a skill file that omits a required step, a CLAUDE.md rule
  that contradicts actual tooling behavior, a script that silently fails under a
  common condition.
- **Nice-to-have**: Would improve quality but will not cause failures if
  deferred. Examples: clearer wording in a guide, additional examples in
  documentation, minor script ergonomic improvements.

Read the sub-agent's output. Store the improvement list for Stage 4.

**Important**: Stage 3 only _identifies and classifies_ improvements. It does
NOT create milestones, tickets, or any Linear artifacts. All creation happens in
Stage 4 after user confirmation for blocking items.

**Depth limit**: Maximum 1 improvement milestone between any two regular
milestones. When this stage is skipped (because the completed milestone is
itself an `Improvements:` milestone), Stages 1 and 2 still run and may surface
new issues. Any such issues are handled as backlog tickets in Stage 4 — never as
a new improvement milestone. The skip condition at the top of this stage
enforces the depth constraint automatically.

## Stage 4: Apply Adjustments

Report the post-merge review results (Stage 0), staff-engineer findings (Stage
1), PM recommendations (Stage 2), and self-improvement review results (Stage 3)
to the user. If Stage 3 was skipped (because the completed milestone starts with
`Improvements:`), explicitly report that the self-improvement review was skipped
due to the depth limit — no new improvements were generated this cycle.

Classify each recommendation as **major** or **minor**:

**Major changes** — require user confirmation before proceeding:

- Skipping or reordering entire milestones
- Adding new prerequisite issues that weren't in the original plan
- Dropping significant planned work
- Fundamental architectural changes
- Creating improvement milestones with blocking tickets

For major changes: present the recommendation and wait for user response via
AskUserQuestion.

**When blocking improvements were identified in Stage 3** (after user
confirmation): create a dedicated improvement milestone and its tickets:

- **Guard**: Before creating, check whether an
  `Improvements: <just-completed milestone name>` milestone already exists
  between the just-completed milestone and the next regular milestone. If one
  exists, reuse it — attach new blocking tickets to the existing milestone
  instead of creating a duplicate.
- **Name**: `Improvements: <just-completed milestone name>`
- **Position**: Insert between the just-completed milestone and the next regular
  milestone
- Create the milestone via `mcp__linear-server__save_milestone` with the project
  ID and appropriate sort order
- Create blocking improvement tickets via `mcp__linear-server__save_issue` with
  the milestone assignment. Each ticket should have a clear title, description
  of the problem observed, and the specific file(s) to modify.
- Typically 1-3 tickets, fast to execute

**Nice-to-have** improvements from Stage 3: Create tickets via
`mcp__linear-server__save_issue` and assign them to the project backlog (no
milestone assignment). Do NOT skip ticket creation — every identified
improvement must have a corresponding Linear ticket. These do not require user
confirmation.

**When the PM recommends new prerequisite issues** (after user confirmation):
create them via `mcp__linear-server__save_issue` with clear title, description,
team, and milestone assignment. Add them to `ISSUE_STATE` as `pending`. Do NOT
merely note them — every recommended issue must exist as a real Linear ticket
before proceeding to Stage 5.

**Minor changes** — apply automatically:

- Re-ordering issues within the next milestone
- Updating issue descriptions to clarify requirements based on what was learned
- Adjusting priority of individual issues

Apply minor changes via Linear MCP:

```
mcp__linear-server__save_issue(id: ..., priority: ...)
```

## Stage 5: Refresh Project State (if tickets changed)

If Stage 4 created improvement tickets or milestones, created new prerequisite
tickets, moved tickets between milestones, or added/removed dependency
relations, the project state file is stale.

Re-dispatch a `general-purpose` sub-agent with brief:

> Read and follow
> `.claude/skills/linear-project/references/fetch-project-overview.md`.
>
> Variables:
>
> - `PROJECT_NAME` = <value>
> - `REPO_OWNER` = <value>
> - `REPO_NAME` = <value>

Wait for completion, read the new JSON at `PROJECT_STATE_PATH`.

- Update `ISSUE_STATE` for any new issues (initialize as `pending`)
- Update `MILESTONES` from the refreshed data (milestone list may have changed)
- **Re-resolve `CURRENT_MILESTONE_INDEX` by stable identifier** — before
  dispatching the refresh, record the current milestone's Linear milestone ID.
  After refresh, locate that ID in the new `MILESTONES` array:
    - If found at the same position, keep the existing index
    - If found at a different position (list was reordered), update
      `CURRENT_MILESTONE_INDEX` to the new position
    - If not found (milestone was deleted or is no longer in the project), pause
      and ask the user which milestone should be treated as "current"
- **Do NOT trust `current_milestone_index` from the refreshed file** — the
  orchestrator's own notion of "current milestone" remains authoritative.
  `fetch-project-overview` computes `current_milestone_index` from Linear
  terminal states (Done/Canceled) only, but the orchestrator also tracks
  `failed`/`skipped` issues that may not be reflected in Linear yet. Trusting
  the refreshed index could regress to a previously completed milestone.

Skip this stage only if no tickets were created or moved and no dependency
relationships were changed — priority-only changes don't affect the graph.

## Stage 6: Sync Main Branch

Before starting the next milestone, ensure the main branch includes all merged
work:

```bash
git fetch origin main
```

Each new worktree in the next milestone will be based on `origin/main`,
automatically incorporating all work from completed milestones.

## Report Format

Report to user:

```
## Milestone "<name>" Complete

### Results
- Done: <count> issues
- Failed: <count> issues (<list if any>)
- Skipped: <count> issues (<list if any>)

### Post-Merge Review
<Summary of deferred items reviewed and follow-up tickets created, if any>

### Architectural Review
<Key findings from staff-engineer>

### Self-Improvement
<Blocking improvements identified and tickets created, if any>
<Nice-to-have improvements filed to backlog, if any>
<Improvement milestone created: Yes/No>

### Roadmap Adjustments
<Recommendations from pragmatic-pm>
<Any actions taken or pending user confirmation>

### Next Up
Milestone "<next-name>": <count> issues ready to start
```
