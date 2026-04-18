# Shared Worktree Operations

All skills that use worktrees follow these standard operations. The worktree
directory convention is `~/projects/worktrees/apps/$DIR_NAME`, where `$DIR_NAME`
is the branch name with `/` replaced by `_` (e.g., branch `feature/foo` becomes
directory `feature_foo`). `scripts/orchestrate find-worktree` applies this
sanitization automatically.

**In practice**, this repo's branch naming conventions (see below) avoid `/` in
branch names, so `$DIR_NAME` equals `$BRANCH_NAME` for all ticket-based and
ad-hoc branches. The commands below use `$BRANCH_NAME` directly in paths, which
is correct for these conventions. If you create a branch with `/`, use
`${BRANCH_NAME//\//_}` for the directory component instead.

## Create Worktree (New Branch)

Creates a worktree with a new branch based on a ref (typically `origin/main`).

**Parameters**: `BRANCH_NAME`, `BASE_REF` (default: `origin/main`)

```bash
git fetch origin main
mkdir -p ~/projects/worktrees/apps
git worktree add -b $BRANCH_NAME ~/projects/worktrees/apps/$BRANCH_NAME $BASE_REF
```

Set `WORKTREE_DIR` to `~/projects/worktrees/apps/$BRANCH_NAME`.

**Sandbox note**: `git worktree add` requires `dangerouslyDisableSandbox: true`
since it writes to `.git/config`.

If `git worktree add` fails, stop and ask the user for guidance.

## Sub-agent Permissions for Worktrees

Background sub-agents working in worktrees cannot receive interactive approval
for tool calls. If `Edit` and `Write` are not pre-approved for the worktree
path, the sub-agent's file modifications will be **auto-denied**.

**Required**: The user's `.claude/settings.local.json` must include:

```json
{
    "permissions": {
        "allow": [
            "Edit(/Users/ian/projects/worktrees/apps/**)",
            "Write(/Users/ian/projects/worktrees/apps/**)"
        ]
    }
}
```

If a sub-agent reports Edit/Write permission failures, check that these entries
exist.

**Note on Bash/sandbox**: Bash commands do NOT need `dangerouslyDisableSandbox`
for worktree operations because:

1. `additionalWritePaths` in sandbox config already covers the worktree path
2. `excludedCommands` exempts `git`, `npm`, `npx`, `nx`, `gh` from sandboxing

The only permission issue for worktree sub-agents is the Edit/Write tool
approval above.

**Used by**: linear-ticket (Phase 2), merge-dependabot (Phase 2), linear-project
(Starting an Issue)

## Create Worktree (Existing Remote Branch)

Creates a worktree tracking an existing remote branch -- no new branch is
created.

**Parameters**: `BRANCH_NAME`

```bash
mkdir -p ~/projects/worktrees/apps
git fetch origin $BRANCH_NAME
git worktree add ~/projects/worktrees/apps/$BRANCH_NAME origin/$BRANCH_NAME
```

Set `WORKTREE_DIR` to `~/projects/worktrees/apps/$BRANCH_NAME`.

**Used by**: resume (Phase R2), fix-failing-prs (per-PR worktree)

## Bootstrap Worktree

Installs dependencies and optionally builds the project.

**Parameters**: `WORKTREE_DIR`, `SKIP_BUILD` (default: false)

```bash
cd $WORKTREE_DIR && npm ci
```

If `SKIP_BUILD` is false (the default):

```bash
cd $WORKTREE_DIR && npm run build
```

If `npm ci` or `npm run build` fails, warn but continue -- the implementation
phase may fix the issue.

**When to skip build**: `merge-dependabot` skips the build during initial
worktree setup because the build happens after merges are applied.

**Used by**: All skills (after worktree creation)

## Remove Worktree

Cleans up a worktree after the PR is merged or work is complete.

**Parameters**: `BRANCH_NAME`

```bash
git worktree remove ~/projects/worktrees/apps/$BRANCH_NAME
```

Do NOT use the `--force` flag -- it is blocked by hooks.

**Used by**: All skills (cleanup phases)

## Branch Naming Conventions

### Ticket-based branches

Branches for Linear tickets follow the pattern set by Linear's `gitBranchName`
field, typically: `<ticket-id-lowercase>-<slug>-<timestamp>`.

### Ad-hoc branches

Branches for ad-hoc work (no Linear ticket) use **underscores only** -- no
hyphens or slashes:

```
adhoc_<slug>_<YYYY_MM_DDTHHMMSS>
```

- `<slug>` is a short lowercase description with underscores for spaces
- Example: `adhoc_fix_flaky_test_2026_03_16T140000`

This convention distinguishes ad-hoc branches from ticket-based branches at a
glance and avoids ambiguity with ticket ID patterns in branch names.

## Detect Existing Worktrees

Searches for worktrees matching a branch name pattern. Used when resuming work
on a previously-started ticket.

**Parameters**: `SEARCH_PATTERN` (a branch name or prefix to match)

```bash
git worktree list --porcelain | grep -A2 "worktree.*$SEARCH_PATTERN"
```

If found, extract `WORKTREE_DIR` from the worktree path and `BRANCH_NAME` from
the branch line.

**Used by**: resume (Phase R1), linear-project (resume detection)
