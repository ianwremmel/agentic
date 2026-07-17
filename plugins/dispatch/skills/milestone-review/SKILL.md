---
name: milestone-review
description: Review one completed milestone — judge its goal against the tickets' DoD artifacts, file follow-ups into the same milestone, record the outcome on the tracker's review artifact, and open the gate to the next milestone. Use when a milestone is ready for review, standalone (/milestone-review <milestone>) or dispatched by an orchestrator.
---

# milestone-review

Review one **milestone**: decide whether its goal was achieved, file any
follow-up work, and open (or hold) the gate to the next milestone. The review
and its gate are yours; nothing else is — you never write code, hold no
compute slot, work no tickets, and never reason over the graph.

**Operator** = the human directing this run — `${user_config.operator_login}`.
The credential mode is `${user_config.credential_mode}`; the default tracker
is `${user_config.tracker}` — both plugin config, never inferred. Wire format
(machine marker + sparkle wrapper for shared credentials):
[`deliver/reference.md`](../deliver/reference.md#wire-format).

## Inputs

The milestone id and its project. Dispatched: the orchestrator also hands the
claim agent id. Standalone: mint `review-<milestone>-<epoch>` yourself.

You are bound by the **communication restriction**: human input routes through
the review artifact (below), never by soliciting or blocking on session input.
Status to the session is fine; standalone, also report the outcome there.

## Tracker adapter

Load the `tracker-adapter-${user_config.tracker}` skill — or
`tracker-adapter-<id>` when the project lives on a different tracker. No
adapter → drive the tracker's native MCP server directly and log an `INFO`
naming the venue you chose as the review artifact.

## The algorithm

1. **Claim** — `dispatch graph claim --id <milestone> --agent <agent-id>`:
   - `claimed` / `refreshed` → step 2.
   - `reclaimed` → takeover of a dead run; eligibility was not re-checked:
     1. `dispatch graph milestone show --id <milestone>`: unless the root
        says `ready-for-review="true" review-recorded="false"`, release and
        exit — the graph moved under the dead run.
     2. Scan the artifact venue for this episode's sentinel (below). Outcome
        already recorded for the current member set → step 6.ii; anything
        less → step 2.
   - `held` (exit 3) → another review is live; stop.
   - not claimable (exit 4) → not ready for review, already reviewed, or
     unknown to the graph. Standalone: refresh the graph
     ([`build-graph`](../build-graph/SKILL.md)) and retry once; still refused
     → nothing to review, report and stop. Dispatched: the graph moved under
     the dispatch; report and exit.
2. **Read**:
   1. `dispatch graph milestone show --id <milestone>` — the milestone
      element and its member nodes. `ready-for-review` on the root *is* the
      readiness check; never re-derive it, never re-verify members.
   2. Through the adapter: the milestone's goal (its description), each
      `verified` member's DoD comment, each `canceled` member's rationale.
3. **Judge** — was the goal achieved, and is follow-up work needed? A DoD's
   deferred items already have tickets; look for the gaps *between* tickets —
   an aim the milestone promised that no ticket delivered or deferred with a
   follow-up ticket, or member evidence that contradicts the goal.
4. If the verdict needs a human judgment you cannot make → **Human input**
   (below), then continue.
5. If follow-ups are needed — the gate stays closed:
   1. File each in the **current** milestone through the adapter.
   2. Write each into the graph: `dispatch graph task set --id <id>
      --project <project> --milestone <milestone> --role available`, plus
      `dispatch graph edge add --blocker <blocker> --blocked <id>` per
      dependency — so the gate holds before the next refresh.
   3. Record what you found and filed on the review artifact, release the
      claim, exit. A fresh review runs when the milestone re-completes.
6. Else — the gate opens:
   1. Post the outcome on the review artifact: the verdict against the goal,
      the per-member evidence you judged it on, and that no follow-up was
      needed.
   2. Final action: `dispatch graph record-review --id <milestone>`. If it
      refuses (the milestone regained open work), release the claim and exit
      — the gate stays closed, and a fresh review runs when the milestone
      re-completes.

Heartbeat throughout — `dispatch graph heartbeat --id <milestone> --agent
<agent-id>` at least every few minutes, folded into any wait. `record-review`
releases the claim; every other exit path releases it explicitly
(`dispatch graph release --id <milestone> --agent <agent-id>`). Never exit
holding it — a stale claim reads as a crash and gets re-dispatched.

## Review artifact

Writes land on the tracker's **review artifact** (the adapter's binding). The
body is wire format; inside it (after the marker, and after the sparkle when
credentials are shared) sits the episode sentinel:

```text
<!-- agent-milestone-review:<milestone-id> -->
```

## Human input

When the verdict needs a judgment you cannot make:

1. Ensure the review artifact exists — post it stating what is pending, no
   verdict.
2. Scan its thread, then ask what is not already pending — batched into one
   comment, tagging ≥1 human. Never re-ask a pending question.
3. Log `WAIT`, naming the artifact and the awaited answer.
4. Poll the thread lazily (minutes, then tens of minutes; never faster than
   once per minute), heartbeating the claim each poll. Waiting is cheap — a
   review holds no compute slot.
5. A question resolves on an addressable response (an answer, a directive,
   an explicit decline): react with a terminal signal, log `RESUME`, and
   post a follow-up when the response was substantive.
6. Every question resolved → record the outcome (never before).

## Log

`INFO` / `WAIT` / `RESUME` / `ERROR` one-liners in the
[`work-ticket` format](../work-ticket/reference.md#logging), with the
milestone's URL in `ticket=` (`-` where the tracker gives it none). A review
never transitions a ticket, so `TRANSITION` and state-change comments do not
apply.
