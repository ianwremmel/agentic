# land — solo operator mode

The operator is the only human in the loop: after Copilot review (where
available), the agent clears draft and engages the operator as the public
reviewer.

## Gates 6–7 in solo

- **Gate 6 (operator-approved)** is satisfied during `public_review_*`.
- **Gate 7** — there is no second approver in this mode. Never evaluated.

## Draft clearing

The agent clears draft on the edge into `ready_for_public_review`. If the
operator clears draft first, just proceed.

## Lifecycle

```mermaid
stateDiagram-v2
    [*] --> starting

    starting --> draft: worktree + empty commit + draft PR + plan comment

    draft --> ready_for_copilot_review: ready · gates 1-5 · Copilot available
    draft --> ready_for_public_review: ready · gates 1-5 · Copilot unavailable (clear draft)

    ready_for_copilot_review --> copilot_review_requested: review requested

    copilot_review_requested --> copilot_commented: Copilot left actionable items
    copilot_review_requested --> ready_for_public_review: Copilot reviewed · zero actionable (clear draft)

    copilot_commented --> ready_for_copilot_review: addressed · gates 1-5 · re-request

    ready_for_public_review --> public_review_requested: operator engaged (engagement comment + notification)

    public_review_requested --> public_review_commented: operator commented (no formal verdict)
    public_review_requested --> public_review_requested_changes: operator changes_requested
    public_review_requested --> public_review_approved: gate 6 satisfied

    public_review_commented --> ready_for_public_review: addressed · gates 1-5 · re-engage
    public_review_requested_changes --> ready_for_public_review: addressed · gates 1-5 · re-engage (required to unblock merge)

    public_review_approved --> ready_for_merge: gates 1-5 still hold

    ready_for_merge --> merged: PR closed (terminal resolved by pr-status)

    merged --> done: worktree removed

    done --> [*]
```

## States

| State                             | Do                                                                                                              | Poll?    |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------- | -------- |
| `starting`                        | Create or locate the worktree (see Setup in `SKILL.md`).                                                        | no       |
| `draft`                           | **Coding happens here.** Edit; pre-push review; push. When ready, check gates 1–5.                              | no       |
| `ready_for_copilot_review`        | Request Copilot review.                                                                                         | no       |
| `copilot_review_requested`        | Await Copilot's review.                                                                                         | CI       |
| `copilot_commented`               | Address each actionable Copilot item; push fix(es).                                                             | no       |
| `ready_for_public_review`         | Clear draft (if still draft). Post the engagement comment (agent-reply marker + `<!-- agent-engagement:<agent-id> -->` sentinel) and notify the operator via your credentials file's venue. Never self-request. | no       |
| `public_review_requested`         | Await the operator's signal.                                                                                    | reviewer |
| `public_review_commented`         | Address each item; push; re-engage.                                                                             | no       |
| `public_review_requested_changes` | Address; push; **re-engage required** — blocks merge.                                                           | no       |
| `public_review_approved`          | Confirm gates 1–5 still hold; else fix in place.                                                                | no       |
| `ready_for_merge`                 | Await merge. **Don't self-merge unless instructed.**                                                            | merge    |
| `merged`                          | Handle per **Ending the run** in `SKILL.md`.                                                                    | no       |
| `done`                            | Terminal.                                                                                                       | —        |

## No formal review

A formal review may never arrive — whether one is even possible is your
credentials file's concern. The engagement comment anchors the reaction- and
reply-based Gate 6 signals; keep polling on the reviewer cadence. "Nobody to
ask" never terminates.
