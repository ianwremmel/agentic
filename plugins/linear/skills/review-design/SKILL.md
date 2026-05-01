---
name: review-design
description:
    Multi-round adversarial debate review of design documents before approval.
    Use when the user invokes "/review-design docs/designs/D-NNN-slug.md".
    Dispatches adversary and defender subagents for structured critique, records
    the full debate transcript in the design doc's Review section, and manages
    status transitions through the review lifecycle.
---

**PLAN MODE GUARD:** If plan mode is active, do NOT proceed. Instead, tell the
user: "The review-design skill is an orchestrator that manages subagents. It
cannot operate in plan mode — please exit plan mode and re-invoke
`/review-design`." Then stop.

# Design Document Review

Announce at start: "I'm using the review-design skill to run an adversarial
review of design document `<DESIGN_DOC_PATH>`."

Parse the design document path from the skill arguments. All phases below use
these shared variables:

- `DESIGN_DOC_PATH` — absolute path to the design document
- `DESIGN_DOC_CONTENT` — full text of the design document
- `DESIGN_TITLE` — extracted from the H1 heading
- `DESIGN_STATUS` — extracted from the `**Status:**` field

## Phase 1: Validate & Prepare

1. Parse `DESIGN_DOC_PATH` from skill arguments. If it's a relative path,
   resolve it against the repo root. Read the file using the `Read` tool. If the
   file does not exist, stop and report: "Design document not found at
   `<path>`."

2. Extract from the document:
    - `DESIGN_TITLE` — the first `#` heading
    - `DESIGN_STATUS` — from the `**Status:**` field in the header

3. **Status validation**: If the `**Status:**` field is missing or cannot be
   parsed into a non-empty `DESIGN_STATUS`, stop and report: "Missing or invalid
   Status field. Design documents must include a `**Status:**` line." Then stop.

4. **Immutability check**: If `DESIGN_STATUS` is "Approved" or "Superseded",
   refuse: "This design document is immutable (status: <status>). Cannot
   review." Then stop.

5. **Template guard**: If the file path ends with `_template.md`, refuse:
   "Cannot review `_template.md`." Then stop.

6. **Status transition**: If `DESIGN_STATUS` is "Draft", edit the `**Status:**`
   line to read `**Status:** In Review`. Use the `Edit` tool for this targeted
   change.

7. **Existing review check**: If a `## Review` section already exists in the
   document (from a previous review round), ask the user via AskUserQuestion:
   "This doc has an existing review transcript. Replace it and start fresh, or
   append new rounds?" Wait for the user's answer before proceeding.

8. **Create/reset the Review section**: Place `## Review` after
   `## Design Details` and before `## Implementation Steps` (if present). If
   neither section exists, append at the end of the document. If the user chose
   to replace an existing review, remove the old `## Review` section and all its
   content before inserting the new one. Use the `Edit` tool for all changes.

## Phase 2: Debate Loop

Minimum 2 rounds, maximum 5 rounds. Early exit on convergence is permitted after
round 2 (i.e., if the adversary returns `REVIEW_RESULT: PASS` and at least 2
rounds have completed).

For each round N (1 through 5):

### Step 1: Adversary Critique

Re-read the design document (the defender may have revised it in the previous
round). Then dispatch a `design-adversary` subagent with:

- The full current `DESIGN_DOC_CONTENT`
- The round number N
- If N > 1, the previous round's defense text (so the adversary can respond to
  rebuttals)
- Instructions:

    > You are reviewing design document '<DESIGN_TITLE>'. This is round N of
    > adversarial review.
    >
    > Critique the design focusing on:
    >
    > - Unstated assumptions
    > - Unhandled edge cases
    > - Alternatives not considered
    > - Risks and failure modes
    > - Logical gaps or contradictions
    >
    > Do NOT critique Implementation Steps — focus on Problem, Solution, and
    > Design Details only.
    >
    > Categorize each issue as one of:
    >
    > - **Critical** — blocks approval; design is unsound without resolution
    > - **Important** — should be addressed but design is viable without it
    > - **Suggestion** — nice-to-have improvement
    >
    > End your review with exactly one of: `REVIEW_RESULT: PASS` — no Critical
    > or Important issues remain `REVIEW_RESULT: FAIL` — any Critical or
    > Important issues remain
    >
    > Use `Read` tool (not cat), `Grep` tool (not rg), `Glob` tool (not find)
    > for any codebase exploration. Do NOT edit any files.

### Step 2: Record Adversary Output

Read the adversary subagent's output. Append it to the design document under
`### Round N — Adversary` within the `## Review` section. Use the `Edit` tool.

### Step 3: Check Convergence

Parse the `REVIEW_RESULT` from the adversary's output.

- If `REVIEW_RESULT: PASS` and N >= 2, exit the debate loop (convergence
  reached). Proceed to Phase 3.
- If `REVIEW_RESULT: PASS` and N == 1, continue to Step 4 (minimum 2 rounds
  required).
- If `REVIEW_RESULT: FAIL`, continue to Step 4.

### Step 4: Defender Response

Dispatch a `staff-engineer` subagent as the defender with:

- The full current `DESIGN_DOC_CONTENT`
- The adversary's critique from this round
- Instructions:

    > You are the author/defender of design document '<DESIGN_TITLE>'. The
    > adversary raised the following issues in round N.
    >
    > For each issue:
    >
    > - If you **ACCEPT**: propose a specific revision to the design doc. State
    >   which section (Problem, Solution, or Design Details) should change, and
    >   provide the exact old text and new text for an Edit tool call.
    > - If you **REBUT**: explain why the concern is not valid or is already
    >   addressed in the design.
    >
    > Be honest — accept valid criticisms. The goal is to strengthen the design,
    > not to win an argument.
    >
    > Use `Read` tool (not cat), `Grep` tool (not rg), `Glob` tool (not find)
    > for any codebase exploration. Do NOT edit any files directly — propose
    > edits as old_text/new_text pairs that the orchestrator will apply.

### Step 5: Apply Accepted Revisions

Parse the defender's output for accepted revisions (old_text/new_text pairs).
Apply each accepted revision to the design document body (Problem, Solution, or
Design Details sections) using the `Edit` tool.

When constructing each Edit call for these revisions:

- Target only the design body sections (Problem, Solution, Design Details).
- Do **not** operate on, search within, or modify the `## Review` section.
- Include enough unique surrounding context from the target section so that
  matches are unambiguous and cannot resolve to content in `## Review`.

### Step 6: Record Defender Output

After all accepted revisions have been successfully applied to the design body,
read the defender subagent's output and append it to the design document under
`### Round N — Author` within the `## Review` section, using the `Edit` tool.

Then proceed to the next round (N + 1), or exit the loop if N == 5.

## Phase 3: Verdict

Count the total rounds completed and determine the final outcome.

### Convergence (adversary PASS, round >= 2)

Present a summary to the user. Ask via AskUserQuestion:

> The adversarial review converged after N rounds. Set status to Approved?
>
> Options: "Approve" / "Keep as In Review" / "Revert to Draft"

Apply the user's chosen status by editing the `**Status:**` line.

### Max rounds reached (5) with Critical issues remaining

Set `DESIGN_STATUS` to "Draft" by editing the `**Status:**` line. Report:

> Review did not converge — N Critical issues remain after 5 rounds. Status
> reverted to Draft.

### Max rounds reached (5) with only Important/Suggestion issues

Ask the user via AskUserQuestion:

> Review completed 5 rounds. No Critical issues remain but N Important issues
> are unresolved. Approve anyway?
>
> Options: "Approve" / "Keep as In Review" / "Revert to Draft"

Apply the user's chosen status by editing the `**Status:**` line.

## Phase 4: Report

Present a final summary:

```text
## Review Complete: <DESIGN_TITLE>

- **Rounds completed:** N
- **Final result:** Converged / Did not converge
- **Final status:** <new status>

### Issues by Round
| Round | Critical | Important | Suggestion | Adversary Result |
|-------|----------|-----------|------------|------------------|
| 1     | N        | N         | N          | PASS/FAIL        |
| 2     | N        | N         | N          | PASS/FAIL        |

### Resolution Summary
- Issues raised: N total
- Issues accepted & revised: N
- Issues rebutted: N
- Issues unresolved: N

The full debate transcript is preserved in the ## Review section of the design
document.
```

## Error Handling

| Scenario                        | Action                                          |
| ------------------------------- | ----------------------------------------------- |
| Design doc not found            | Stop, report path                               |
| Status is Approved/Superseded   | Stop, explain immutability                      |
| Missing Status field            | Stop, explain required header format            |
| Adversary subagent fails        | Report error, ask user: retry or stop           |
| Defender subagent fails         | Record adversary round, ask user: retry or stop |
| Edit tool fails (text mismatch) | Re-read file, retry with corrected old_text     |
| User cancels mid-review         | Preserve transcript so far, revert to Draft     |
