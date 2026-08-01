# deliver — dedicated credentials

The agent acts under its own dedicated account (`credential_mode: dedicated`),
separate from the operator's. Posts appear under the agent's account and are
identified by the machine marker alone — **never add the sparkle wrapper**
([wire format](./reference.md#wire-format)).

## Operator notification

When an engagement edge fires (your operator-mode file says which), notify via
the platform's PR review-request API targeting `operator_login`. Also post the
engagement comment — marker + `agent-engagement` sentinel
([mechanics](./reference.md#operator-engagement)).

## Gate 6 signals

Every Gate 6 form is available, including the formal one: the operator's
approval typically lands as `<review mode="human" role="operator"
state="approved">` in the `pr-status` XML. Reaction, reply, and ticket-side
signals count too.

## Review rules

A platform may restrict a review type to human accounts (Copilot on GitHub
refuses a bot-account request). This plugin defines no second credential to
work around that: if the request is refused, say so on the PR and continue to
the next state. Set `copilot_available: false` to skip the phase outright.
