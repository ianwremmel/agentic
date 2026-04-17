# Post-Merge Review Protocol

Review merged PRs that have deferred work to ensure follow-up tickets exist for
every deferred item. This protocol prevents deferred work from being forgotten
after a PR merges.

## When Invoked

- During milestone review (Stage 1) — before architectural review
- At start of `/linear-project` — before the first milestone begins
- On demand by the user

## Prerequisites

- `REPO_OWNER`, `REPO_NAME` — repository coordinates

## Protocol

### Step 1: Find Merged PRs with Deferred Work

```bash
gh pr list --repo "$REPO_OWNER/$REPO_NAME" --state merged --label needs-followup --json number,title,body,url
```

If no PRs are returned, report "No merged PRs with deferred work found" and
exit.

### Step 2: Process Each PR

For each PR returned in Step 1:

#### 2a: Extract Deferred Items from PR Body

Read the PR body's `## Decisions` section. Look for items marked as deferred,
such as:

- Lines containing "deferred" (case-insensitive)
- Lines containing "follow-up" or "followup" (case-insensitive)
- Lines referencing work not completed in the PR

Build a list of deferred items with their descriptions.

#### 2b: Find Comments Needing Post-Merge Review

Find comments on the PR with a `confused` reaction (indicating the item should
be verified after merge):

```bash
gh api repos/$REPO_OWNER/$REPO_NAME/pulls/$PR_NUMBER/comments --paginate --jq '
  [.[] | select(.reactions.confused > 0) | {id, body, path, user: .user.login}]
'
```

Also check issue comments:

```bash
gh api repos/$REPO_OWNER/$REPO_NAME/issues/$PR_NUMBER/comments --paginate --jq '
  [.[] | select(.reactions.confused > 0) | {id, body, user: .user.login}]
'
```

#### 2c: Verify Follow-up Tickets Exist

For each deferred item from Step 2a and each `confused`-reacted comment from
Step 2b:

1. Check if the `## Decisions` section already references a Linear ticket URL
   next to the deferred item (format: `https://linear.app/...` or ticket ID like
   `CLC-NNN`)
2. If a ticket reference exists, verify the ticket exists via
   `mcp__linear-server__get_issue`
3. If no ticket reference exists, the item needs a follow-up ticket

#### 2d: Create Missing Follow-up Tickets

For each deferred item without a corresponding ticket:

1. Extract the parent ticket ID from the PR body (look for `Resolves [CLC-NNN]`
   or similar patterns)
2. Create a sub-issue via `mcp__linear-server__save_issue` with:
    - Title: clear description of the deferred work
    - Description: reference to the original PR and the specific deferred item
    - `parentId`: the parent ticket ID (if found)
3. Add a comment on the PR noting the created ticket:
    ```bash
    gh pr comment $PR_NUMBER --body "Created follow-up ticket <TICKET_URL> for: <deferred item description>"
    ```

#### 2e: React to Reviewed Comments

For each `confused`-reacted comment that has now been reviewed (ticket verified
or created):

React with `hooray` to indicate post-merge review is complete:

```bash
# For inline review comments:
gh api repos/$REPO_OWNER/$REPO_NAME/pulls/comments/$COMMENT_ID/reactions \
  -f content=hooray

# For issue comments:
gh api repos/$REPO_OWNER/$REPO_NAME/issues/comments/$COMMENT_ID/reactions \
  -f content=hooray
```

#### 2f: Remove the Label

After all deferred items have been verified and all `confused`-reacted comments
have been reviewed:

```bash
scripts/orchestrate label remove "$PR_NUMBER" needs-followup
```

### Step 3: Report Results

Report a summary for each processed PR:

```
## Post-Merge Review Results

### PR #<number>: <title>
- Deferred items found: <count>
- Items with existing tickets: <count>
- New tickets created: <count> (<ticket URLs>)
- Confused-reacted comments reviewed: <count>
- Label removed: yes/no
```

## Error Handling

- If a PR's `## Decisions` section is missing or empty, skip that PR and report
  it as having no deferred items to review.
- If ticket creation fails, log the error but continue processing other items.
  Do NOT remove the `needs-followup` label if any items remain unresolved.
- If the `gh pr list` command fails, report the error and exit without
  processing.
