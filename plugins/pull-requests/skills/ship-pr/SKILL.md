---
name: ship-pr
description:
    Drive an existing draft PR through implementation, pre-push validation, CI
    monitoring, code review, and completion until it reaches a terminal state
    (approved, merged, closed, or escalated). Invoked by other skills
    (linear-ticket, resume, merge-dependabot, linear-project) after a worktree
    and draft PR already exist. Has no knowledge of Linear or any external
    tracker — callers own any pre/post hooks that need to update external
    systems.
---

# Ship PR

Announce at start: "I'm using the ship-pr skill to drive PR #`$PR_NUMBER` to
completion."

## Inputs

The calling skill must have set:

- `WORKTREE_DIR` — absolute path to the worktree
- `BRANCH_NAME` — the branch being shipped
- `PR_NUMBER` — the draft PR number
- `REPO_OWNER` / `REPO_NAME` — repository coordinates
- `COMMIT_SCOPE` — the conventional commit scope (e.g., `nx`, `deps`). The
  implementing agent may derive this from the package(s) it modifies.
- `IMPLEMENTATION_BRIEF` — description of the work to implement, or a signal to
  skip implementation (e.g., merge-dependabot enters at the Monitoring Step
  after merging)

### Resuming from a Previous Session

CI monitoring and review monitoring state (`ci_fix_attempts`, `review_cycles`,
and the `watermark_*_id` values) live **exclusively** in the PR body's
`<!-- clc-progress -->` block. They are NOT accepted as direct skill inputs,
because `pr-monitor` restores state from the PR progress block only.

When resuming, the caller is responsible for ensuring the PR progress block
reflects the desired starting state **before** entering this skill. Use
`scripts/orchestrate progress write "$PR_NUMBER" <key>=<value>` to persist
values if the caller needs to override defaults. Typical keys:

- `ci_fix_attempts` (default 0)
- `review_cycles` (default 0)
- `watermark_review_id`, `watermark_comment_id`, `watermark_issue_comment_id`
  (default 0)

If the caller does not need to override anything, the defaults in the progress
block are used as-is.

Prefix all Bash commands with `cd $WORKTREE_DIR &&` since Bash cwd does not
persist between tool calls.

## Outputs

- `result` — one of `approved` | `merged` | `closed` | `escalated`
- `summary` — human-readable description of the final state
- `deferred_items` — the parsed list of deferred entries from the PR body's
  `## Decisions` section. Callers may use these to fan out follow-up work in an
  external tracker. See **Deferred Item Format** below for the required syntax.

### Deferred Item Format

Deferred work MUST be recorded in the PR body's `## Decisions` section as a
markdown list where each deferred item begins with the literal prefix
`- **Deferred:**` (case-sensitive). Any text on the same line after the prefix
is the human-readable description. Sub-bullets attached to a deferred item are
treated as additional context for that item.

Example:

```markdown
## Decisions

- **Deferred:** error recovery middleware (tracked separately so the initial
  rollout stays focused on the happy path).
- **Deferred:** retry middleware.
- Chose option A over option B because X.
```

**Parsing rule.** `ship-pr` parses `## Decisions` by scanning Markdown list
items and, for each item, removing the leading list marker (`- `, `* `, or `+ `
followed by a single space) before matching. An item is treated as a deferred
entry if and only if its post-marker content begins with the literal string
`**Deferred:**`. Each matching item's inline text (together with any sub-bullet
context) becomes a single `deferred_items` entry; all other list items are
ignored.

**Authoring rule.** Despite the parser tolerating `- `, `* `, and `+ ` list
markers, implementers and callers MUST write deferred items using the exact
Markdown prefix `- **Deferred:**` (hyphen + space + bold `Deferred:`). The
hyphen form is the only shape this project treats as canonical, and entries
recorded any other way will not be surfaced to callers via `deferred_items`.

## Procedure

Load and follow `references/execution-loop.md`. The loop is self-contained —
each step checks its own prerequisites, so callers may enter at a specific step:

- **Implementation Step** — default entry for fresh work
- **Pre-push Validation Step** — entry when implementation has been committed
  locally but not yet pushed
- **Monitoring Step** — entry when code has been pushed and CI / review are the
  only remaining concerns (used by `merge-dependabot` after Phase 3 and by
  `resume` when the PR already has implementation commits)
- **Completion Step** — entry when CI has already passed and the PR just needs
  to be marked ready, summarized, and handed to reviewers

After the loop returns, read the final PR body's `## Decisions` section and
extract any deferred items so the caller can decide whether to file follow-ups.

## Error Handling

| Scenario                  | Action                                          |
| ------------------------- | ----------------------------------------------- |
| 3 CI fix attempts fail    | Return `escalated` with attempted fixes summary |
| 5 review cycles exhausted | Return `escalated` with outstanding issues      |
| PR closed during monitor  | Return `closed` with closure reason             |
| Monitoring poll timeout   | Return `escalated` with last known state        |
