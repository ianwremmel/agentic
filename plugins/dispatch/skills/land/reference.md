# land — protocol reference

## Roles

- **Agent** — the agentic coding assistant doing the work (this skill).
- **Operator** — the one individual directing the agent; almost certainly
  human; the only human with stop authority.
- **Reviewer** — any participant leaving review feedback (Copilot, another agent,
  or a human). The operator may also be a reviewer.

The credential mode is plugin config, stated in the skill's Environment
section and described by your credentials file. Never infer it from account
names.

## Wire format

Every agent-authored post (new post or thread reply — not reactions) carries one
machine marker as its **first line**, alone, no leading whitespace:

```text
<!-- agent-reply:<agent-id> -->
```

That marker is the whole of the universal format. Your credentials file gives
the body format for this environment — follow it exactly, and add nothing it
doesn't call for.

The plan-comment sentinel `<!-- agent-plan:<agent-id> -->` goes **inside** the
body, **alone on its own line** — that is what `pr-status` matches, and a
sentinel sharing a line with prose is not seen at all, leaving the comment
actionable forever. It never comes first; the marker does.

## Terminal signals

A terminal signal means "finished with this item"; it suppresses re-evaluation
next poll. Anything else means "still working." The agent signals finished
**only** via a terminal signal — it MUST NOT resolve the thread, even one it
opened. Platform-resolved threads are read (see
[Actionability](#actionability)) but never written by the agent.

Reactions settle a **top-level comment** and are preferred there. They never
settle a thread — `pr-status` doesn't read them on threads; use a
terminal-tagged reply instead.

| Reaction | Meaning                               |
| -------- | ------------------------------------- |
| `+1`     | Terminal — addressed / agreed         |
| `-1`     | Terminal — rejected (with a reply)    |
| `rocket` | Terminal — shipped / merged / applied |
| `eyes`   | Non-terminal — seen, in progress      |

Text tokens are the terminal mechanism on threads, and on any platform without
reactions. When you emit one it must be the **last non-empty line**. Emit only
these three. The reader is more lenient
than the writer: `pr-status` also accepts `✓`, `✅`, `acknowledged`, `wontfix`,
`dismissed`, and `resolved`, so a reviewer's stray "resolved" can settle an
item — don't rely on it, and don't add to this set:

| Token       | Meaning               |
| ----------- | --------------------- |
| `Done.`     | Terminal (≡ `+1`)     |
| `Declined.` | Terminal (≡ `-1`)     |
| `Shipped.`  | Terminal (≡ `rocket`) |

## Review rules

- An agent MUST NOT request review from the account it is authenticated as.
- Per-credential-mode rules are in your credentials file.
- The self-request prohibition constrains the *request*, not the loop — the
  no-eligible-reviewer handling in the operator-mode files (skip the request,
  keep polling) still applies.

### Operator engagement

`land` engages the operator on the edge your operator-mode file marks. Each
engagement is two parts:

1. **Notification** — the venue your credentials file prescribes.
2. **Engagement comment** — a top-level PR comment carrying the
   `<!-- agent-reply:<agent-id> -->` marker AND, inside the body (after the
   body) and alone on its own line, an engagement sentinel
   `<!-- agent-engagement:<agent-id> -->`. Posted in both
   credential modes (the notification venues aren't PR comments the operator
   can react to). It anchors reaction-/reply-based Gate 6 signals.

The sentinel makes the comment classify **non-actionable** (like the plan
comment) — without it, the agent's own soliciting comment stays actionable
forever, failing Gate 4 and blocking draft-clear/merge. Do **not** terminal-tag
it instead: the agent is awaiting approval, not finished.

## Actionability

`pr-status` classifies each item `actionable="true|false"` by the rules below.

A comment or thread is **non-actionable** iff any of:

- it's one of the calling agent's artifact comments — an `agent-plan` or
  `agent-engagement` sentinel AND author = the calling gh identity (the author
  match keeps a human quoting a marker actionable).
- the newest comment was written by the calling agent (author = calling
  identity) AND carries an `agent-reply` marker AND its last non-empty line is a
  terminal token from the table above (case-insensitive, trailing period
  optional). The author match keys on the gh-authenticated login.
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
- `ticket=`/`pr=` — full URLs, never bare IDs; `-` when absent.
- `ticket-role=` — a role name from [`ticket.md`](./ticket.md); `-` on
  PR-only runs.
- `<pr-state>` — `draft` | `open` | `shipped` | `abandoned`; `-` when no PR.

Kinds `land` emits:

| Kind         | When                                                                                    |
| ------------ | --------------------------------------------------------------------------------------- |
| `INFO`       | Heartbeats while polling; substantive non-state events.                                 |
| `WAIT`       | Entering a poll; message names the venue and awaited outcome.                           |
| `RESUME`     | The awaited condition is met and work resumes.                                          |
| `ERROR`      | Errors surfaced but not immediately fatal.                                              |
| `BLOCK`      | A "report and stop" path — an unclaimable ticket, a refused required request.            |
| `TRANSITION` | (Ticket-backed runs) a ticket role change.                                              |

Each ticket role change also gets a state-change comment on the ticket, in wire
format. Body exactly:

```text
State: <prev-role> → <new-role>
Rationale: <one line>
```
