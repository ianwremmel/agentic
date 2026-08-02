# land — shared credentials

The agent posts with the operator's own account, so `operator_login` is also the
authenticated account. Three consequences: readers
can't tell agent posts from the operator's by author; a review request can never
target the operator; and the operator can only leave `commented` reviews on this
PR, never `approved` or `changes_requested`. GitHub refuses all three on your
own PR.

## Wire format

Author alone can't identify an agent post here, so the body inside the marker
([wire format](./reference.md#wire-format)) is wrapped in a sparkle block:

```text
<!-- agent-reply:<agent-id> -->
✨

Fixed in abc1234.

✨

Done.
```

The sparkle (U+2728) sits alone on its line, one blank line in from the body on
each side. **A terminal token goes after the closing sparkle**, as shown:
`pr-status` reads the last non-empty line and nothing else, so a token inside
the block is never seen — the closing sparkle is that line — and the item stays
actionable forever. Reactions are unaffected, and a sentinel is matched wherever
it sits, so it may stay inside the block.

## Operator notification

When an engagement edge fires (your operator-mode file says which), post the
engagement comment — marker + `agent-engagement` sentinel
([mechanics](./reference.md#operator-engagement)) — then notify the operator
separately, since a review request can't reach them:

1. a ticket comment tagging the operator, when the work has a ticket;
2. otherwise, in the session: say you are waiting on the operator's approval and
   what for.

The engagement comment never notifies anyone — it posts under the operator's
own account — but it still anchors the reaction- and reply-based Gate 6
signals.

## Gate 6 signals

`pr-status` will never report `<review role="operator" state="approved">` here —
the platform refuses self-review, so that element cannot exist on this PR. Don't
wait for it. Any one of these satisfies the gate instead:

- `<reaction emoji="+1">` on the engagement comment. **Never react to your own
  engagement comment in this mode** — you and the operator post under one login,
  so a `+1` you added there is indistinguishable from their approval and you
  would clear your own gate. The sentinel already keeps that comment
  non-actionable, so it never needs a terminal signal from you;
- a "go ahead" / "lgtm" / "ready" reply from the operator, on the engagement
  comment, the ticket, or out of band;
- a ticket-side approval, such as an operator status transition.

## Reading reviews — the inverse rule

The absence of a formal `changes_requested` never means "no changes
requested." Every operator comment — review comment, inline comment, or
top-level PR comment — is either a question to answer or an implicit change
request.

## Review rules

Requests to reviewers other than the authenticated account work normally.
