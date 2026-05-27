---
name: deliver
description: Drive a code change to merge through a draft PR — CI, reviews, iteration, monitor until close. Use whenever the unit of work is "land this change," whether the trigger is a prompt or a ticket. Implements the Delivery Protocol (§2.4) using the PR Status Protocol (§2.2) for state.
---

# deliver

Land a code change via a PR. On every tick: run `scripts/pr-status`, address every actionable concern, then evaluate exit gates to decide whether to transition.

## Setup

1. **Worktree.** Work inside `<worktree_base>/<owner>/<repo>/<branch>` (`worktree_base` is a `userConfig` value; default `~/.worktrees`). Find existing with `git worktree list` — never guess. Reuse if present.
2. **PR-open sequence** (skip if a PR is already open for this branch):
   - `git commit --allow-empty -m "chore: open PR [skip ci]"` — never amend or squash this commit.
   - Push; open a **draft** PR. Body: Motivation, Ticket link (omit entirely if none — bare IDs are non-conforming), Test plan. **No execution plan in the body.**
   - Post the plan as a top-level PR comment. Include `<!-- agent-plan:<agent-id> -->` inside the §2.1 body (after the machine marker / sparkle line, not before). Pin if supported.
3. **Resuming.** If a PR already exists: reuse worktree, skip the open sequence, find the existing plan comment by its `agent-plan` marker. If missing, post one. Never open a second PR; never retroactively rewrite the body.

## Gates

Seven binary signals read from each `pr-status` XML:

1. **CI.** `<checks state="passing">`. The protocol's rollup already treats `neutral`/`success` as passing and lets the repo suppress specific non-blocking checks via `informational="true"`.
2. **No conflicts.** `<merge-conflicts present="false"/>`.
3. **No actionable annotations.** Zero `<annotation actionable="true">`.
4. **No actionable comments.** Zero `<comment actionable="true">`.
5. **No actionable threads.** Zero `<thread actionable="true">`.
6. **Operator pre-approved.** Team mode only. The operator has signalled approval on the pre-review pass — a formal approval review (Mode A), a `+1` reaction on the engagement comment, a "go ahead" reply, or an explicit "ready/clear draft" instruction. Trivially satisfied in solo mode (no pre-review stage).
7. **Human-approved.** At least one `<review mode="human" state="approved">` from a non-self reviewer, and no current `changes_requested` from any reviewer. In solo mode the approver is the operator; in team mode it must be a non-self, non-operator reviewer.

Gates 1–5 are evaluated at every tick across every lifecycle state outside `starting`/`done`. **Gate failures are addressed in place — they do not change the state.** Only the conditions listed on each transition edge below trigger a state change.

## Solo vs team mode

The `team_mode` config flag selects whether the operator gets a private pre-review while still in draft:

- **Solo mode** (`team_mode = false`, default). The operator is the sole human reviewer. After Copilot the agent clears draft and requests review from the operator. There is no `operator_pre_review_*` stage. The lifecycle is `… → ready_for_human_review (draft cleared) → human_review_* → ready_for_merge → …`.
- **Team mode** (`team_mode = true`). After Copilot the agent engages the operator while the PR is still in draft (`operator_pre_review_*`). Only after the operator approves does the agent clear draft and request team review. The lifecycle is `… → operator_pre_review_* (in draft) → ready_for_human_review (draft cleared) → human_review_* → …`.

In solo mode, "human" in the human-review states means the operator. In team mode, "human" excludes the operator (they already reviewed in the pre-review stage) — review is requested from at least one other human.

## Lifecycle

```mermaid
stateDiagram-v2
    [*] --> starting

    starting --> draft: worktree + empty commit + draft PR + plan comment

    draft --> ready_for_copilot_review: ready · gates 1-5 · Copilot available
    draft --> ready_for_operator_pre_review: ready · gates 1-5 · Copilot unavailable · team mode
    draft --> ready_for_human_review: ready · gates 1-5 · Copilot unavailable · solo mode

    ready_for_copilot_review --> copilot_review_requested: review requested

    copilot_review_requested --> copilot_commented: Copilot left actionable items
    copilot_review_requested --> ready_for_operator_pre_review: Copilot reviewed · zero actionable · team mode
    copilot_review_requested --> ready_for_human_review: Copilot reviewed · zero actionable · solo mode

    copilot_commented --> ready_for_copilot_review: addressed · gates 1-5 · re-request

    ready_for_operator_pre_review --> operator_pre_review_requested: operator engaged (PR review request in Mode A, ticket/out-of-band in Mode B). PR stays in draft.

    operator_pre_review_requested --> operator_pre_review_commented: operator commented (non-binding)
    operator_pre_review_requested --> operator_pre_review_approved: operator approved / signalled ready

    operator_pre_review_commented --> ready_for_operator_pre_review: addressed · gates 1-5 · re-engage

    operator_pre_review_approved --> ready_for_human_review: draft cleared · gates 1-5 still hold

    ready_for_human_review --> human_review_requested: draft cleared · reviewer requested
    ready_for_human_review --> human_review_requested: no eligible reviewer (skip request)

    human_review_requested --> human_review_commented: reviewer commented (non-binding)
    human_review_requested --> human_review_requested_changes: reviewer changes_requested
    human_review_requested --> human_review_approved: reviewer approved

    human_review_commented --> ready_for_human_review: addressed · gates 1-5 · re-request
    human_review_requested_changes --> ready_for_human_review: addressed · gates 1-5 · re-request (required to unblock merge)

    human_review_approved --> ready_for_merge: gates 1-5 still hold

    ready_for_merge --> merged: PR closed (merged)

    merged --> done: worktree removed

    done --> [*]
```

Universal terminal (not drawn, applies from every state): **PR closed (merged or not)** or **operator "stop" instruction** → acknowledge per §2.1 → `merged` → `done`. This includes the sole-reviewer case, where the explicit `human_review_approved → ready_for_merge → merged` path is unreachable and the merge fires the universal edge directly out of `human_review_requested`. Worktree cleanup happens on **any** closure.

## States

| State                            | Do                                                                                                                                            | Poll?    |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `starting`                       | Create or locate the worktree (§Setup).                                                                                                       | no       |
| `draft`                          | **Coding happens here.** Edit; pre-push review; push. When ready, check gates 1–5.                                                            | no       |
| `ready_for_copilot_review`       | Request Copilot review.                                                                                                                       | no       |
| `copilot_review_requested`       | Await Copilot's review.                                                                                                                       | CI       |
| `copilot_commented`              | Address each actionable Copilot item; push fix(es).                                                                                           | no       |
| `ready_for_operator_pre_review`  | Team mode only. Engage the operator (Mode A: PR review request on the draft. Mode B: ticket comment, then out-of-band). PR stays in draft.    | no       |
| `operator_pre_review_requested`  | Team mode only. Await the operator's response.                                                                                                | reviewer |
| `operator_pre_review_commented`  | Team mode only. Address each item; push; re-engage the operator. PR stays in draft.                                                           | no       |
| `operator_pre_review_approved`   | Team mode only. Confirm gates 1–5 still hold; clear draft (or observe the operator clearing it); proceed to `ready_for_human_review`.        | no       |
| `ready_for_human_review`         | Clear draft (solo mode entry only — already cleared in team mode); request reviewer(s). Never self-request. Mode A/B per reference.           | no       |
| `human_review_requested`         | Await a reviewer's review.                                                                                                                    | reviewer |
| `human_review_commented`         | Address each item; push; re-request review.                                                                                                   | no       |
| `human_review_requested_changes` | Address; push; **re-request required** — `changes_requested` blocks merge until cleared.                                                      | no       |
| `human_review_approved`          | Confirm gates 1–5 still hold; else fix in place.                                                                                              | no       |
| `ready_for_merge`                | Await merge. **Don't self-merge unless instructed.**                                                                                          | merge    |
| `merged`                         | Acknowledge (§2.1); remove any worktree you created.                                                                                          | no       |
| `done`                           | Terminal.                                                                                                                                     | —        |

**Coding does NOT happen in:** `ready_for_copilot_review`, `copilot_review_requested`, `ready_for_operator_pre_review`, `operator_pre_review_requested`, `operator_pre_review_approved`, `ready_for_human_review`, `human_review_requested`, `human_review_approved`, `ready_for_merge`, `merged`, `done`. Code changes in those states are only legal as the response to a gate-1–5 failure (CI broke, conflict arose, a new actionable annotation/comment/thread appeared) — and that work is "addressing concerns in place," not advancing the lifecycle.

**Eligible reviewer selection in `ready_for_human_review`.** The agent MUST NOT request review from itself. In **team mode** the agent MUST also exclude the operator (they already reviewed in the pre-review stage); the request goes to at least one other human. In **solo mode** the operator is the eligible reviewer.

**Self as sole eligible reviewer.** If no eligible human reviewer exists (e.g. team mode with no non-operator human reviewer available), `ready_for_human_review` skips the request but still transitions to `human_review_requested` and keeps polling on the reviewer cadence. Gate 7 is unreachable in this case, which is fine — the PR is merged out-of-band, the agent observes closure on a poll, and the universal `merged → done` terminal fires. "Nobody to request from" is not a termination condition.

## Per-concern handling

Apply to every actionable item the XML emits, not just the first.

| XML signal                                            | Action                                                                                                                                                             |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `<merge-conflicts present="true"/>` (gate 2 fails)    | Rebase or merge the target branch; resolve.                                                                                                                        |
| `<checks state="failing">` (gate 1 fails)             | Diagnose root cause; fix.                                                                                                                                          |
| Actionable `<comment>` or `<thread>` (gates 4–5 fail) | Reply per §2.1 with **either** a commit link describing what changed **or** a one-line dismissal rationale. Apply terminal signal. Resolve threads when satisfied. |
| Actionable `<annotation>` (gate 3 fails)              | Fix the code, OR dismiss by writing `<cache>/$id.ack` with the rationale captured in the plan comment or commit body.                                              |

## Cross-cutting behaviors

These apply in every state; they are not states themselves.

- **Pre-push review.** Before every significant push: simplify pass + adversarial pass by a distinct reviewer. Triage every finding (act or one-line dismissal). Non-significant pushes (the empty `chore: open PR`, whitespace/format-only, trivial typo/lint fixes) skip pre-push review; if unsure, treat as significant.
- **Reply to every reviewer item.** Commit link or dismissal rationale. Silence is non-conforming. Human comments get more deference than bot ones; operator comments get more deference than any other reviewer's.
- **Plan comment is the living plan.** Edit in place: check off completed steps, strike through abandoned ones with a one-line rationale (don't delete), append new ones. The PR body's Motivation and Test plan stay stable.
- **First green.** Gate 1 must be satisfied by a green CI rollup achieved _after_ the agent first attempts to leave `draft` (i.e. reaches `ready_for_copilot_review`, `ready_for_operator_pre_review`, or `ready_for_human_review`). Greens on intermediate commits before that moment do not satisfy gate 1.
- **Heartbeats.** While polling, emit INFO heartbeats per §2.3 (`ticket=-` when there is no linked ticket).
- **Termination is narrow.** Plan completion, green CI, review requests, `ready_for_merge`, and "nobody to request review from" do not terminate. Only PR closure or an explicit operator "stop" terminates. The agent runs the lifecycle through itself — see §Polling/Mechanism — and is never re-prodded by a caller (operator or orchestrator) to make forward progress.
- **Re-derive termination each tick.** Decide termination from the current `pr-status` read; never carry "if X then stop" conditions across ticks. The loop amplifies them, and only the narrow list above is grounds for stopping.

## Polling

Adaptive, not fixed. Build project memory and use it to dodge unnecessary traffic. **Never poll faster than once per minute.**

| Waiting on                             | Schedule                                                                                 |
| -------------------------------------- | ---------------------------------------------------------------------------------------- |
| CI (`<checks state="pending">`)        | 60 s. Lengthen to ~5 min once past the project's typical CI duration without completion. |
| Reviewer reply after a request         | 5 min for the first hour; then 30 min.                                                   |
| Merge after reaching `ready_for_merge` | 5 min for the first hour; then 30 min.                                                   |

### Mechanism

The agent is the poll loop. Polling is done by the agent itself, inline, via sequential foreground tool calls — typically `Bash` `sleep` followed by a `pr-status` re-read and any reactive work the new state requires. The agent stays continuously active in its current turn until a lifecycle terminal (see "Termination is narrow"); it does not yield its turn back to a caller, hand off to a wakeup, or expect anyone to re-prod it. This holds whether `deliver` is invoked directly by the operator or dispatched as a subagent (e.g. `linear-project`'s `deliver-worker`).

For waits longer than the Bash tool timeout (~10 min), do **not** use a single long `sleep`. Split into shorter intervals — a 30-minute reviewer wait becomes ~5×6-minute `sleep`s, each followed by a cheap `pr-status` check. Re-checking more often than the schedule above is fine; the table is an upper bound on the wait, not a lower bound on the loop.

Forbidden patterns (each has been observed to silently strand a PR mid-lifecycle):

- **Detached background poll loops.** Any `run_in_background: true` Bash whose body repeats `touch <lock>; sleep; poll` in any form — `while true`, `until`, plain `touch; sleep; touch` triplets, `nohup`, `disown`, etc. Spawning a detached loop and then exhausting the agent's tool calls leaves the OS process polling indefinitely while the agent itself is reaped; the lock keeps heartbeating forever even though no reactive work can happen, and the PR sits orphaned with the `agent-working` signal still set.
- **Suspending on `Monitor`** as the poll vehicle. The harness's armed-monitor pattern observably fails to wake long polls — the agent yields, the wake never fires, the PR is silently unmonitored. Stay in-turn with foreground `sleep`s instead.
- **Ending the turn before a lifecycle terminal.** Returning early — for "no actionable work right now," for "the caller will check back," or any reason short of merged / closed / explicit operator "stop" — orphans the PR. The corresponding instruction to a caller is: **do not design the caller around mid-lifecycle re-dispatch.** A live `deliver` agent is expected to be doing the work.

When the agent reaches a lifecycle terminal, or exits in response to an explicit operator "stop" it can catch, it runs whatever cleanup the dispatch brief specifies (lock file removal, `agent-working` label removal, status file write). Abnormal exits (API errors, OOM, harness reaping) are out of the agent's reach; the caller's stale-state sweep is the backstop for those, not a substitute for the agent's discipline.

### Project memory

Maintain a small history file at `<cache-base>/<skill>/<repo-slug>/_history.jsonl`. On every observed wait, append one line:

```json
{ "ts": "...", "kind": "ci|reviewer|merge", "elapsed_s": 0, "outcome": "..." }
```

On entry to a polling state, read the median `elapsed_s` for that kind and tune the schedule above: shorten the head when CI is typically fast; lengthen the tail when reviewers are typically slow. Cap the history at the most recent ~100 entries per kind.

## Configuration

Read from the plugin's `userConfig` (env: `CLAUDE_PLUGIN_OPTION_*`):

| Key                 | Effect                                                                                                                                                                                                |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `copilot_available` | `false` → skip the Copilot phase entirely. Default `true`.                                                                                                                                            |
| `worktree_base`     | Root directory for per-PR worktrees. Layout: `<base>/<owner>/<repo>/<branch>`. Default `~/.worktrees`.                                                                                                |
| `team_mode`         | `true` → add an `operator_pre_review_*` stage (in draft) before `ready_for_human_review`; review in `human_review_*` is requested from a non-operator human. `false` → solo: operator is the sole reviewer in `human_review_*`. Default `false`. |

## References

The bits this skill leans on — Mode A/B detection, the machine marker and
sparkle wrapper, terminal signals, actionability, and the operational-log line
format — are condensed in [`reference.md`](./reference.md), bundled so the skill
is self-contained once installed. That file points back to the full dispatch
spec (§2.1 Communication, §2.2 PR Status, §2.3 Logging, §2.4 Delivery) where the
two differ.
