---
name: create-pr
description:
    Create a draft pull request from an existing worktree. Invoked by other
    skills (linear-ticket, resume, linear-project) after a worktree exists on a
    new branch. Wraps `scripts/orchestrate start-pr` — handles the empty initial
    commit, push, draft PR creation, and idempotency error handling. Returns
    `PR_NUMBER` and `PR_URL` for the caller.
---

# Create Draft PR

Announce at start: "I'm using the create-pr skill to open a draft PR for
`$BRANCH_NAME`."

## Inputs

The calling skill must have set:

- `WORKTREE_DIR` — absolute path to the worktree
- `BRANCH_NAME` — the **head** branch the PR will be opened from, i.e. the
  branch that is already checked out inside `$WORKTREE_DIR`. This is NOT the
  base branch the PR merges into — the base is always `main`. `BRANCH_NAME` must
  match `git -C $WORKTREE_DIR rev-parse --abbrev-ref HEAD`.
  `scripts/orchestrate start-pr` derives the head branch from the worktree on
  its own and does not accept a branch argument, so `BRANCH_NAME` is consumed
  only for the start-of-skill announcement and for a pre-flight sanity check
  against the worktree.

Optional inputs (passed through to `scripts/orchestrate start-pr` when set):

- `TICKET_ID` — opaque identifier used for the PR title scope, if the caller is
  working from a tracked ticket
- `TICKET_URL` — opaque link included in the PR body, if the caller wants a
  back-reference to the source of truth for the work

This skill has no knowledge of Linear — it treats `TICKET_ID`/`TICKET_URL` as
opaque strings that get passed through to the underlying script.

Prefix all Bash commands with `cd $WORKTREE_DIR &&` since Bash cwd does not
persist between tool calls.

## Outputs

- `PR_NUMBER` — the draft PR number
- `PR_URL` — the PR's web URL

## Procedure

Delegate to `scripts/orchestrate start-pr`, which handles the empty commit (with
a proper conventional commit message), push, and draft PR creation in a single
command. **Include the `--ticket-id` / `--ticket-url` flags only when the caller
actually set the corresponding variables** — empty-string values are not safe,
because `start-pr` will treat an empty flag value as an explicit ticket
reference and produce malformed PR titles and bodies.

Build the command conditionally. Ad-hoc (no ticket):

```bash
scripts/orchestrate start-pr "$WORKTREE_DIR"
```

Ticket-backed:

```bash
scripts/orchestrate start-pr "$WORKTREE_DIR" \
  --ticket-id "$TICKET_ID" \
  --ticket-url "$TICKET_URL"
```

The command returns JSON to stdout. Parse the output to set `PR_NUMBER` and
`PR_URL`:

```json
{
    "pr_number": 123,
    "pr_url": "https://github.com/...",
    "branch_name": "my-branch"
}
```

The `start-pr` script also seeds the initial `clc-progress` block in the PR
body. Callers do not need to write one themselves.

## Idempotency / Failure Handling

`scripts/orchestrate start-pr` is **not** idempotent. Handle failures carefully:

- If it failed **before** creating the empty PR commit (e.g., local validation
  error), fix the issue and retry `start-pr` once.
- If it failed **after** creating the empty commit locally but **before**
  pushing it (e.g., `git push` failure), do not rerun `start-pr` — it will
  create additional empty commits. Instead, fix the underlying issue and retry
  the push or subsequent `gh pr create` directly from the existing branch.
- If the failure occurred **after** the commit was pushed (e.g., flaky
  `gh pr create`), do not rerun `start-pr`. Check whether the branch exists on
  the remote and create the PR directly with `gh pr create`, or ask the user for
  guidance.

## Error Handling

| Scenario                    | Action                              |
| --------------------------- | ----------------------------------- |
| `start-pr` local validation | Fix issue, retry once               |
| `git push` flake            | Retry push directly, do not rerun   |
| `gh pr create` flake        | Create PR directly, do not rerun    |
| Branch already has open PR  | Return existing PR number to caller |
