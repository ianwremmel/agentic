---
name: review-milestone
description: Review a milestone that has become ready for review — judge whether its goal was achieved, file any follow-up work into that same milestone, and record the outcome on the milestone's review artifact. Use when a milestone completes, standalone or dispatched by an orchestrator.
---

# review-milestone

Every ticket in the milestone is `verified` or `canceled`. Decide whether that
added up to the milestone's goal, and record the verdict — nothing downstream
advances until you do.

## Do

1. **Read the milestone**: its goal, its tickets, and each ticket's
   definition-of-done comment. Those comments are the evidence; a ticket
   `verified` without one is itself a finding.
2. **Judge the goal** against that evidence — the goal, not the ticket count.
   Every ticket can be `verified` and the goal still missed.
3. **File follow-up in the *current* milestone** — never the next one.
4. **Record the outcome** as a comment on the milestone's review artifact (a
   Linear project update): whether the goal was achieved, on what evidence, and
   every follow-up ticket filed.

## Human input

Route it through **comments on the review artifact**, tagging a human — never the
session. Scan the artifact first: keep at most one open request. Do **not** record
the outcome until it resolves — a recorded outcome opens the gate. Exit
`awaiting-input`.

## Report

Standalone: report to the session. Dispatched: hold the heartbeated
milestone-keyed lock and write `outcome.xml` in your `dispatch-state unit dir` as
your final action
([`orchestrate/reference.md`](../orchestrate/reference.md#dispatch)):

```xml
<outcome key="milestone:M1" result="recorded|awaiting-input|failed" detail="one line">
  <followup id="DEV-44"/>
</outcome>
```

Comments carry the machine marker and mode-appropriate wrapper
([`work-ticket/reference.md`](../work-ticket/reference.md#communication-recap));
log lines follow
[`work-ticket/reference.md`](../work-ticket/reference.md#logging).
