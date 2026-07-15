# deliver — protocol reference

The communication, PR-status, and logging rules `deliver` relies on. With
[`SKILL.md`](./SKILL.md) and `scripts/pr-status`, this is the complete authority
for the skill.

## Roles

- **Agent** — the agentic coding assistant doing the work (this skill).
- **Operator** — the one individual directing the agent. Exactly one per
  session; almost certainly human; the only human with stop authority. May share
  platform credentials with the agent (Mode B).
- **Reviewer** — any participant leaving review feedback (Copilot, another agent,
  or a human). The operator may also be a reviewer.

## Mode detection

Determined by the credentials held at write time.

- **Mode A** (agent-credentialed) iff the platform types the account a
  bot/integration/service account, OR the identifier (login, display name, or
  email local-part) matches `*copilot*`, `*codex*`, `*claude*`, or `*ai-agent*`
  case-insensitively.
- **Mode B** (human-credentialed) otherwise. **On any ambiguity, default to Mode
  B.**

## Wire format

Every agent-authored post (new post or thread reply — not reactions) carries one
machine marker as its **first line**, alone, no leading whitespace:

```text
<!-- agent-reply:<agent-id> -->
```

In **Mode B**, the body is additionally wrapped in a sparkle block after the
marker:

```text
<!-- agent-reply:dispatch -->
✨

{body}

✨
```

The sparkle (U+2728) sits alone, one blank line in from the body each side.
Never in Mode A. The plan-comment sentinel `<!-- agent-plan:<agent-id> -->` goes
**inside** the body (after the marker in Mode A, after the opening sparkle in
Mode B), never as the leading line.

## Terminal signals

A terminal signal means "finished with this item"; it suppresses re-evaluation
next poll. Anything else means "still working." The agent signals finished
**only** via a terminal signal — it MUST NOT resolve the thread, even one it
opened. Resolution is a human's call. Platform-resolved threads are read (see
[Actionability](#actionability)) but never written by the agent.

Reactions (preferred where supported):

| Reaction | Meaning                               |
| -------- | ------------------------------------- |
| `+1`     | Terminal — addressed / agreed         |
| `-1`     | Terminal — rejected (with a reply)    |
| `rocket` | Terminal — shipped / merged / applied |
| `eyes`   | Non-terminal — seen, in progress      |

Text tokens (platforms without reactions) — must be the **last non-empty line**:

| Token       | Meaning               |
| ----------- | --------------------- |
| `Done.`     | Terminal (≡ `+1`)     |
| `Declined.` | Terminal (≡ `-1`)     |
| `Shipped.`  | Terminal (≡ `rocket`) |

## Review rules

- An agent MUST NOT request review from the account it is authenticated as.
- A Mode A agent MAY use alternative human credentials to request a
  human-restricted review type (e.g. Copilot review on GitHub).
- **Mode B inverse:** on a PR the agent authored under shared credentials, the
  absence of a formal `changes_requested` does NOT mean "no changes requested" —
  every operator comment is a question to answer or an implicit change request.
- **Sole-reviewer case.** "MUST NOT request review from self" constrains the
  *request*, not the loop. When the agent is the author and no eligible non-self
  human reviewer exists, it skips the request but keeps polling on the reviewer
  cadence until the PR closes (`merged → done` handles closure). Terminating
  early because there's nobody to ask is non-conforming.

### Operator engagement (deliver-specific)

`deliver` engages the operator on two edges: `ready_for_private_review →
private_review_requested` (team) and `ready_for_public_review →
public_review_requested` (solo). Each engagement is two parts:

1. **Notification** — the Mode-specific venue below.
2. **Engagement comment** — a top-level PR comment carrying the
   `<!-- agent-reply:<agent-id> -->` marker AND, inside the wrapped body, an
   engagement sentinel `<!-- agent-engagement:<agent-id> -->`. Posted in both
   Modes (the notification venues aren't PR comments the operator can react to).
   It anchors reaction-/reply-based Gate 6 signals.

The sentinel makes the comment classify **non-actionable** (like the plan
comment) — without it, the agent's own soliciting comment stays actionable
forever, failing Gate 4 and blocking draft-clear/merge. Do **not** terminal-tag
it instead: the agent is awaiting approval, not finished.

Notification venue by Mode:

- **Mode A** (separate bot account) — the platform's PR review-request API,
  targeting `operator_login` (required; the agent fails if it's unset).
- **Mode B** (shared credentials) — the review-request API can't target the
  authenticated account, so use the Mode B human-review venues: a ticket comment
  tagging the operator first, then an implementation-defined out-of-band channel.
  Operator identity is `operator_login`, which here is the shared/authenticated
  account.

### Audience by visibility stage

The lifecycle names states by **visibility**, not audience; audience falls out
of the mode:

| State family       | Visibility          | Audience (solo) | Audience (team)              |
| ------------------ | ------------------- | --------------- | ---------------------------- |
| `private_review_*` | draft (not cleared) | unreachable     | operator                     |
| `public_review_*`  | draft cleared       | operator        | non-operator team reviewer(s) |

## Actionability

Drive **all** gate and actionability decisions from `pr-status`, reading the
cache files it wrote rather than re-fetching; raw `gh`/MCP reads are costly and
bypass the classification the gates rely on. You may directly read *emergent*
data the snapshot doesn't cover, but the PR status you act on comes only from
`pr-status` — routine `gh`/MCP calls are writes.

The agent reads `actionable="true|false"` and treats it as the **sole task
source**. A non-actionable item carries a `reason=` token (`resolved`,
`agent-artifact`, `agent-terminal-reply`, `acked`). A `<summary>` is a **reading
aid, not a work queue**: it recaps the item's *content*, not its resolution, so a
terminal-tagged item still reads as open — expected, not grounds to reopen. Trust
the flag and `reason=`.

Reviews are surfaced as one persistent record per reviewer under `<reviews>`,
each `state` of `pending | commented | changes_requested | approved | dismissed`.
`pending` is requested-but-undelivered — in-flight, not absent (a bot's inline
threads can land minutes later). An outstanding request **overrides** any prior
verdict back to `pending` until the reviewer re-reviews. An unsubmitted draft
review isn't surfaced at all. Keep polling rather than chasing either.

A comment or thread is **non-actionable** iff any of:

- it's one of the calling agent's artifact comments — a line-anchored
  `agent-plan` or `agent-engagement` sentinel AND author = the calling gh
  identity (the author match keeps a human quoting a marker actionable). These
  never need addressing; the engagement comment in particular must stay
  non-actionable while awaiting approval, else Gate 4 blocks draft-clear/merge.
- the newest comment was written by the calling agent (author = calling
  identity) AND carries an `agent-reply` marker AND its last non-empty line is a
  terminal signal (`Done.`/`Declined.`/`Shipped.`, case-insensitive, optional
  trailing period, or `✓`/`✅`). The author match keys on the gh-authenticated
  login; `pr-status` exits early if it can't resolve that login (a `gh api user`
  failure is fatal, since it's the only identity source).
- the calling agent reacted to it with a terminal reaction (`+1`/`-1`/`rocket`;
  comments only). Top-level comments have no reply threading, so this is the
  only signal that can settle a comment someone else authored.
- the platform has explicitly resolved the thread (threads only).

A reviewer reply after the agent's last turn re-actionables the item. An
annotation is actionable unless `<cache>/<id>.ack` exists.

## Operational logging

One line per entry:

```text
<timestamp> <kind> ticket=<ticket-url> pr=<pr-url> ticket-role=<role> pr-state=<state> | <message>
```

- `<timestamp>` — RFC 3339 with offset, second precision.
- `<kind>` — `TRANSITION` | `WAIT` | `RESUME` | `BLOCK` | `INFO` | `ERROR`.
- `ticket=`/`pr=` — full URLs, never bare IDs; `-` when absent.
- `<pr-state>` — the resolved `<terminal state>`: `draft` | `open` (non-terminal)
  or `shipped` | `abandoned` (terminal); `-` when no PR.

Kinds `deliver` emits:

| Kind         | When                                                                                    |
| ------------ | --------------------------------------------------------------------------------------- |
| `INFO`       | Heartbeats while polling; substantive non-state events.                                 |
| `WAIT`       | Entering a poll; message names the venue and awaited outcome.                           |
| `RESUME`     | The awaited condition is met and work resumes.                                          |
| `ERROR`      | Errors surfaced but not immediately fatal.                                              |
| `TRANSITION` | (Ticket-driven runs) a ticket role change.                                             |

When a linked ticket's role changes, also post a state-change comment to the PR
(or ticket) in wire format, body exactly:

```text
State: <prev-role> → <new-role>
Rationale: <one line; required for corrective and cancel transitions>
```
