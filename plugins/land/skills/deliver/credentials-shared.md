# deliver — shared credentials

The agent shares the operator's platform credentials
(`credential_mode: shared`): every post lands under the operator's own
account. Two consequences drive everything below: readers can't tell agent
posts from the operator's by author, and a review request can never target the
operator (the platform refuses requests naming the authenticated account).

## Wire format

Every agent post carries the machine marker **and wraps the body in the
sparkle block** ([wire format](./reference.md#wire-format)) — the sparkle is
how readers tell agent posts from the operator's own.

## Operator notification

When an engagement edge fires (your operator-mode file says which), the
review-request API can't target the operator (see above), so notify by:

1. a ticket comment tagging the operator, when the work has a ticket;
2. otherwise, the session — say plainly that you are waiting on the operator's
   approval and what you're waiting for. With no ticket and no review request,
   the engagement comment reaches nobody: it lands under the operator's own
   account, which the platform does not notify.

Operator identity is `operator_login` — here the shared/authenticated account.
Also post the engagement comment — marker + `agent-engagement` sentinel
([mechanics](./reference.md#operator-engagement)).

## Gate 6 signals

A formal approved review is impossible on a PR the shared account authored
(the platform refuses self-review), so Gate 6 arrives only in the non-formal
forms of `SKILL.md`'s Gate 6 list: reaction, reply, or ticket-side approval.

## Reading reviews — the inverse rule

The absence of a formal `changes_requested` never means "no changes
requested." Every operator comment — review comment, inline comment, or
top-level PR comment — is either a question to answer or an implicit change
request.

## Review rules

Requests to reviewers other than the authenticated account work normally.
