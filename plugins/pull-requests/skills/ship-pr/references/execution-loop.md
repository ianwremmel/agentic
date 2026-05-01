# Execution Loop: Implement → CI → Review → React

This is the shared execution loop owned by the `ship-pr` skill and consumed by
`linear-ticket`, `resume`, `merge-dependabot`, and `linear-project`. All shared
variables must be set before entering this loop.

## Prerequisites

The calling skill must have set:

- `BRANCH_NAME`, `WORKTREE_DIR`, `PR_NUMBER`
- `REPO_OWNER`, `REPO_NAME`
- `COMMIT_SCOPE` — the conventional commit scope, derived from the package being
  modified (e.g., `nx`, `deps`). The implementing agent determines this from the
  package(s) being changed.
- `IMPLEMENTATION_BRIEF` — description of the work to implement, or a signal to
  skip implementation

Monitoring state (CI fix attempts, review cycles, and review watermarks) is read
exclusively from the PR body's `<!-- clc-progress -->` block and is **not**
accepted as direct variables. When resuming, the caller is responsible for
writing the desired starting values into the progress block **before** entering
this loop, using `scripts/orchestrate progress write $PR_NUMBER <key>=<value>`.
See the **PR Progress Update Protocol** below for the canonical schema.

Prefix all Bash commands with `cd $WORKTREE_DIR &&` since Bash cwd does not
persist between tool calls.

## PR Progress Update Protocol

This protocol is the single source of truth for how progress state is persisted
to the PR body. All steps in this loop and all subagents must follow this
protocol when reading or writing progress.

### Reading Progress

1. Read progress via `scripts/orchestrate progress read $PR_NUMBER`.
2. Parse the output as YAML to get field values.
3. If output is empty, assume defaults: all counters at 0,
   `implementation_complete: false`, and `phase` based on heuristic assessment
   of the PR state.

### Writing Progress

1. Update fields via
   `scripts/orchestrate progress write $PR_NUMBER field=value ...`
   (automatically fetches body, updates block, and writes back).
2. Update checklist items via
   `scripts/orchestrate progress checklist $PR_NUMBER "<item>" checked|unchecked`.

### Canonical Schema

```
<!-- clc-progress
phase: implementation
ci_fix_attempts: 0
review_cycles: 0
implementation_complete: false
commit_scope: unknown
last_updated: 2026-02-27T18:00:00Z
watermark_review_id: 0
watermark_comment_id: 0
watermark_issue_comment_id: 0
-->
```

Fields:

- `phase` — `implementation` | `pre_push` | `monitoring` | `done`
- `ci_fix_attempts` — count of CI fix cycles consumed (out of max 3)
- `review_cycles` — count of review fix cycles consumed (out of max 5)
- `implementation_complete` — distinguishes "draft with no work" from "draft
  with implementation pushed"
- `commit_scope` — conventional commit scope (survives resume)
- `last_updated` — ISO 8601 timestamp
- `watermark_review_id` — max review ID seen
- `watermark_comment_id` — max inline comment ID seen
- `watermark_issue_comment_id` — max issue comment ID seen

### Progress Checklist Format

```markdown
## Progress

- [ ] Implementation
- [ ] CI passing (attempt 0/3)
- [ ] Code review requested
- [ ] Review feedback addressed (cycle 0/5)
- [ ] Merged
```

### When to Update

Update the PR progress block at these transition points:

- After implementation subagent completes
- After pre-push validation and push
- After each CI fix attempt
- After CI passes and PR is marked ready
- After each review fix cycle (with updated watermarks)
- After PR merge

## Implementation Step

Before dispatching any subagent, rebase the worktree on the latest `origin/main`
to avoid merge conflicts and ensure the implementation starts from a current
base:

```bash
scripts/orchestrate setup "$WORKTREE_DIR"
```

If the setup reports a conflict, abort the rebase
(`scripts/orchestrate setup "$WORKTREE_DIR" --abort`) and escalate to the user.

Before dispatching the implementation subagent, signal that work is starting:

```bash
cd $WORKTREE_DIR && scripts/orchestrate label add "$PR_NUMBER" agent-working
```

Label failures are best-effort and will not block the workflow.

1. Dispatch a `senior-engineer` subagent with:
    - The `IMPLEMENTATION_BRIEF` as the requirements specification
    - The worktree absolute path — all file operations happen there
    - **Worktree permission note**: See "Sub-agent Permissions for Worktrees" in
      `../../references/worktree.md`. Edit/Write tools require pre-approved
      permission entries in settings.local.json for background sub-agents.
    - **Tool usage: Use `Grep` (not rg/grep), `Read` (not cat/head/tail),
      `Edit`/`Write` (not sed/awk/heredocs) for all file operations.**
    - Instructions to follow TDD, use conventional commit format with
      `COMMIT_SCOPE` as scope (e.g., `feat($COMMIT_SCOPE): add endpoint`). The
      agent should determine the scope from the package(s) being modified (e.g.,
      `nx`, `merge-dependabot`), not from any external ticket identifier.
    - Instructions to commit incrementally as logical units of work are
      completed
    - **PR size constraint: Keep total new/changed code under 500-800 lines
      (excluding lockfiles and generated files). Test files count toward the
      budget. If the implementation would exceed this, implement only the core
      functionality and note what was deferred. Do NOT try to implement
      everything if it would create a large PR.**
    - **Documentation requirement: Update all affected documentation (CLAUDE.md,
      AGENTS.md, README.md, and relevant guides in `docs/`) alongside the code
      changes. Documentation is NOT a separate work item — it is part of
      implementation.**

2. After the senior-engineer completes, get the diff:

    ```bash
    cd $WORKTREE_DIR && git diff origin/main...HEAD
    ```

    Then dispatch **all 6 review agents in parallel** (single message, 6
    subagent calls). Each agent receives the diff output and the worktree path.
    All agents must: run `git diff origin/main...HEAD` in the worktree, read
    CLAUDE.md and AGENTS.md in affected packages, and use `Grep` (not rg/grep),
    `Read` (not cat/head/tail), and `Glob` for all file inspection operations.
    Do not edit or write any files during review (no `Edit`/`Write`,
    `sed`/`awk`/heredocs, or other mutating commands). Each agent must end its
    output with:

    ```text
    REVIEW_RESULT: PASS|FAIL
    ```

    Agents that track issue counts (code-reviewer, staff-engineer) should also
    include `CRITICAL_COUNT` and `IMPORTANT_COUNT`. For agents that don't
    categorize by severity (technical-writer, test-reviewer,
    consistency-reviewer, reuse-checker), `REVIEW_RESULT` alone is sufficient.
    The orchestrator treats any `REVIEW_RESULT: FAIL` as a blocking failure
    regardless of whether counts are present.

    The 6 agents and their focus areas:

    a) **`staff-engineer`** — architectural consistency: codegen pipeline
    compliance, interactor pattern, package organization, OpenAPI extensions,
    dependency management, queue dispatch rules, Express setup rules. Read
    CLAUDE.md and AGENTS.md in affected packages. Read
    `docs/guides/service-package-patterns.md` for the Reuse Table.

    b) **`code-reviewer`** — type precision, input validation, repository
    conventions, correctness, security. Include the **rename consistency
    checklist** as a priority:
    - **Renamed symbols**: All references to renamed symbols are updated —
      JSDoc, error messages, test descriptions, log messages, and comments.
    - **Backward-compat shims**: Any backward-compatibility shims include a
      clear deprecation signal (e.g., a JSDoc `@deprecated` annotation and/or a
      `console.warn` when there's a runtime alias), consistent with repo
      conventions.
    - **Test descriptions**: Test `describe`/`it` strings match what the test
      actually asserts, not stale terminology from before the rename.
    - **Exports**: Barrel/index files follow the package's existing export style
      (many use `export *`).
    - **Variable naming**: Local variables match the concept they represent
      (e.g., a variable holding tasks is not named `events`).

    c) **`technical-writer`** — documentation quality: CLAUDE.md/AGENTS.md
    accuracy, new packages documented, concise and actionable docs, valid
    cross-references, AI agent context.

    d) **`consistency-reviewer`** — stale documentation, docstring accuracy, and
    DRY: renamed symbols have updated JSDoc, new constants aren't duplicated as
    hard-coded literals in tests, callers use new signatures, commit messages
    match code. Additionally, for all new functions: JSDoc/docstring claims
    (behavioral descriptions, @param, @returns, @throws) match the actual
    implementation — flag aspirational or inaccurate docstrings.

    e) **`test-reviewer`** — test accuracy and coverage: test names match
    assertions, test data exercises claimed edge cases, colocated `.test.mts`
    siblings for source files, handlers have tests.

    f) **`reuse-checker`** — framework reuse: no direct
    `QueueClient`/`queueClient.send()` (use `dispatch()`), no direct
    `subscribe()` (use `x-tasks`), no manual `express()` (use `setup()`), no
    manual route wiring (use `api.yml`), no `main.mts`/`bin` in service
    packages, no direct NATS/SQS clients. These rules do not apply to framework
    packages or release/deployment packages.

3. Collect all 6 `REVIEW_RESULT` outputs.

4. **If ALL agents return PASS** (or only Suggestions remain): Proceed to step 6
   (Update PR progress), then the Pre-push Validation Step.

5. **If ANY agent returns FAIL**:
    - Consolidate all blocking findings from ALL failing agents (for agents that
      report severities, include Critical and Important counts)
    - Dispatch a new `senior-engineer` subagent with the consolidated findings
      and the worktree path to fix them
    - After fixes, re-dispatch all 6 review agents in parallel
    - **Maximum 2 review-fix cycles.** If still failing after 2 cycles, proceed
      to step 6 (Update PR progress) and then the Pre-push Validation Step,
      noting outstanding issues.

6. **Update PR progress** following the PR Progress Update Protocol:
    - `phase`: `pre_push`
    - `implementation_complete`: `true`
    - `commit_scope`: the scope determined by the implementing agent (read from
      the agent's commits or status file)
    - Check "Implementation" in the progress checklist

## Pre-push Validation Step

Before pushing implementation or fix work, dispatch a `senior-engineer` subagent
to validate the worktree. This catches `diff` and `lint` CI failures locally
instead of wasting 15-25 minutes on a CI round-trip. Skip this step only for the
initial empty-commit push in the draft PR phase.

Dispatch the subagent with:

- The worktree absolute path
- Instructions to:
    1. Run `npm run validate` (this builds all packages — regenerating
       `__generated__/` files — then runs all linters and unit tests)
    2. If the build produced diffs (e.g., codegen output, dependency manifests),
       stage and commit them with `chore($COMMIT_SCOPE): regenerate after build`
    3. If lint or tests failed, fix the issues, commit the fixes, and re-run
       `npm run validate` until it passes (max 3 attempts)
    4. If `lint:consumers` fails, run `scripts/update-consumers` to regenerate
       CLAUDE.md consumer sections, then stage and commit the changes
    5. Report back what changes were made (if any) and whether validate passes

After the subagent completes, push all changes:

```bash
cd $WORKTREE_DIR && git push origin $BRANCH_NAME
```

After the push succeeds, remove the working label and **update PR progress**:

```bash
cd $WORKTREE_DIR && scripts/orchestrate label remove "$PR_NUMBER" agent-working
```

- `phase`: `monitoring`
- `last_updated`: current ISO 8601 timestamp

## Prerequisite Discovery

During implementation or review, the agent may discover that the current work
cannot be completed correctly without work that doesn't exist yet. This is
distinct from deferring nice-to-have follow-ups.

**Decision criteria:**

- **Prerequisite** (use this protocol): The missing work blocks correctness.
  Without it, the current PR would be broken, incomplete in a way that can't
  ship, or architecturally unsound. Examples: "this endpoint needs a new
  database table that doesn't exist," "this feature requires an auth middleware
  that hasn't been built."
- **Deferral** (use follow-up items in `## Decisions`): The missing work is
  nice-to-have, improves quality, or handles edge cases. The current PR can ship
  without it. Examples: "error recovery for rare failure modes," "performance
  optimization."

**Prerequisite protocol:**

1. Record the prerequisite discovery in the PR body's `## Decisions` section so
   the caller can act on it (e.g., create a blocking ticket in an external
   tracker).
2. Close the current PR with a comment explaining: "Closing — this work requires
   the prerequisite work recorded in `## Decisions` to be completed first. Will
   re-open or create a new PR after the prerequisite is done."
3. EXIT the execution loop with result `closed` — do not continue with CI or
   review. The caller is responsible for any external tracker updates (reopening
   tickets, creating prerequisite tickets, etc.).

## Monitoring Step

After pushing, dispatch the `pr-monitor` agent to own the full CI polling,
review monitoring, comment handling, and completion loop. The agent is defined
at `.claude/agents/pr-monitor.md` and handles both CI polling and review
feedback in a single unified phase-based algorithm.

Summary of key rules:

- Uses
  `scripts/orchestrate poll "$PR_NUMBER" "$SHA" --review-watermark ... --comment-watermark ... --issue-comment-watermark ...`
  for all polling
- Checks all signals every iteration: reviews → CI failures → merge conflicts →
  completion/approval. No phase-gated processing.
- `completion_done` is the sole state flag, gating the Completion Step and
  Copilot re-requests
- Pre-computed fields (`bk_terminal`, `approval_state`, `has_new_feedback`,
  `copilot_clean_review`) eliminate agent reasoning per poll
- On CI failure: analyze, fix, push, continue loop (max 3 attempts)
- On review feedback requiring code changes: fix, push, continue loop
- On approval with no new feedback: exit approved
- On merge/close: exit with appropriate result

Before dispatching the monitoring subagent, rebase to pick up any changes merged
while the implementation was in progress:

```bash
scripts/orchestrate setup "$WORKTREE_DIR"
```

Dispatch the `pr-monitor` agent (`run_in_background: true`) with:

- All shared variables: `WORKTREE_DIR`, `BRANCH_NAME`, `PR_NUMBER`,
  `REPO_OWNER`, `REPO_NAME`, `COMMIT_SCOPE`
- `SHA` — the HEAD commit SHA after the last push
- Instructions to return a result (`approved` | `merged` | `closed` |
  `escalated`) and summary

Read the subagent's result:

- **`approved`**: PR is approved — proceed to merge monitoring or return to
  caller
- **`merged`**: PR was merged during monitoring — return to caller
- **`closed`**: PR was closed — report to user and return to caller
- **`escalated`**: Max fix cycles reached — report outstanding issues to user

The orchestrator does NOT run the polling loop itself — the subagent owns the
entire CI + review cycle including any code fixes, CI re-monitoring, and thread
replies.

## Completion Step

When CI passes:

1. Mark the PR as ready for review:

    ```bash
    cd $WORKTREE_DIR && scripts/orchestrate ready "$PR_NUMBER"
    ```

    **Draft PRs must be marked ready BEFORE requesting Copilot review** —
    Copilot will not review draft PRs.

2. Update the PR body with a real summary replacing the placeholder bullets from
   the draft PR. Summarize what was implemented, key design decisions, and test
   coverage. Write the body to a temp file and update via
   `gh pr edit $PR_NUMBER --body-file <tmpfile>`.

    **IMPORTANT**: When rewriting the PR body with the real summary, you MUST
    preserve the `<!-- clc-progress ... -->` block and the `## Progress`
    checklist. Update progress via:

    ```bash
    scripts/orchestrate progress write "$PR_NUMBER" phase=monitoring
    scripts/orchestrate progress checklist "$PR_NUMBER" "CI passing" checked
    scripts/orchestrate progress checklist "$PR_NUMBER" "Code review requested" checked
    ```

    Add a `## Decisions` section listing key implementation decisions:
    - Architectural choices made during implementation
    - Work deferred due to PR size constraints (see the required Deferred Item
      Format below)
    - Refinements to the original specification

3. **Record deferred work in the `## Decisions` section** using the required
   syntax. Each deferred entry MUST be a top-level markdown list item with the
   exact prefix `- **Deferred:**` — this is the same contract documented in the
   **Deferred Item Format** section of `../SKILL.md`, and `ship-pr` parses only
   list items that match it. Example:

    ```markdown
    ## Decisions

    - **Deferred:** error recovery middleware (focusing rollout on the happy
      path first).
    - **Deferred:** retry middleware.
    - Chose option A over option B because X.
    ```

    The caller (e.g., `linear-ticket`, `linear-project`) is responsible for
    turning the parsed `deferred_items` into follow-up items in whatever
    external tracker it owns.

    **Do NOT say "filed as a known gap" or "deferred to a follow-up" without
    recording a concrete `- **Deferred:**`entry in`## Decisions`.** Every
    deferred item must be surfaced there using the exact required prefix so the
    caller can act on it.

    After recording deferred items, react to any deferred reviewer comments with
    `rocket` (indicating deferred for later). For items that should be verified
    after merge, react with `confused` (needs post-merge review).

4. **Add `needs-followup` label if deferred items exist.** If the `## Decisions`
   section contains any deferred items, add the `needs-followup` label to the
   PR:

    ```bash
    cd $WORKTREE_DIR && scripts/orchestrate label add "$PR_NUMBER" needs-followup
    ```

    This label signals to the post-merge review protocol
    (`../../references/post-merge-review.md`) that the PR has deferred work
    requiring verification after merge. The post-merge review runs during
    milestone reviews and at the start of `/linear-project` to ensure all
    deferred items have corresponding follow-up tickets.

    Skip this step if no items were deferred.

5. Update the PR title to include the correct scope now that the package is
   known: `<type>(<scope>): <concise-description>` where `<scope>` is the
   primary package that was modified.

6. Request Copilot review (must happen after step 1 — Copilot ignores draft
   PRs):

    ```bash
    cd $WORKTREE_DIR && scripts/orchestrate review copilot "$PR_NUMBER"
    ```

    **WARNING**: NEVER use `gh pr edit --reviewer` directly — it replaces the
    entire reviewer list. Always use `scripts/orchestrate review copilot` and
    `scripts/orchestrate review human`, which use `--add-reviewer` to preserve
    existing reviewers.

7. Report the PR URL to the user — tell them Copilot review has been requested.
   **Do NOT request human review.** Human review is requested exclusively by the
   monitoring subagent (after Copilot is satisfied) or by the orchestration loop
   tick (after `copilot_clean` is true). Requesting it here would create noise
   for the human reviewer before automated review is complete.

## Entering at a Specific Step

Skills may enter this loop at any step (e.g., `resume` enters based on assessed
state, `merge-dependabot` enters at the Monitoring Step after merging). Each
step is self-contained and checks its own prerequisites:

- **Implementation**: No prior state needed beyond the shared variables
- **Monitoring**: Assumes code has been pushed; gets HEAD SHA for polling.
  Handles CI, completion, and review in a single unified loop.
