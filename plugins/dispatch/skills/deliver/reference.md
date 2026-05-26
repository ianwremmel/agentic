# deliver — protocol reference

Condensed from the dispatch spec (§2.1 Communication, §2.2 PR Status, §2.3
Operational Logging). Only the parts `deliver` relies on are reproduced here so
the skill is self-contained once installed. The full spec is authoritative where
they differ.

## Mode detection (§2.1)

Determined by the credentials held at write time, not the environment.

- **Mode A** (agent-credentialed) iff EITHER the platform types the account as a
  bot/integration/service account, OR the identifier (login, display name, or
  email local-part) matches `*copilot*`, `*codex*`, `*claude*`, or `*ai-agent*`
  case-insensitively.
- **Mode B** (human-credentialed) otherwise. **On any ambiguity, default to Mode
  B.**

## Wire format (§2.1)

Every agent-authored post (new top-level post or thread reply — not reactions)
carries exactly one machine marker as its **first line**, alone, no leading
whitespace:

```
<!-- agent-reply:<agent-id> -->
```

In **Mode B**, the body is additionally wrapped in a sparkle block after the
marker:

```
<!-- agent-reply:dispatch -->
✨

{body}

✨
```

The sparkle (U+2728) sits alone on its own line, one blank line in from the body
on each side. The wrapper MUST NOT appear in Mode A posts.

The plan-comment sentinel `<!-- agent-plan:<agent-id> -->` goes **inside** the
body (after the marker in Mode A, after the opening sparkle in Mode B), never as
the leading line.

## Terminal signals (§2.1)

A terminal signal means "finished with this item"; it suppresses re-evaluation
on the next poll. Anything else means "still working."

Reactions (preferred where supported):

| Reaction | Meaning                               |
| -------- | ------------------------------------- |
| `+1`     | Terminal — addressed / agreed         |
| `-1`     | Terminal — rejected (with a reply)    |
| `rocket` | Terminal — shipped / merged / applied |
| `eyes`   | Non-terminal — seen, work in progress |

Text tokens (platforms without reactions) — must be the **last non-empty line**:

| Token       | Meaning               |
| ----------- | --------------------- |
| `Done.`     | Terminal (≡ `+1`)     |
| `Declined.` | Terminal (≡ `-1`)     |
| `Shipped.`  | Terminal (≡ `rocket`) |

## Review rules (§2.1)

- An agent MUST NOT request review from the account it is authenticated as.
- A Mode A agent MAY use alternative human credentials to request a review type
  the platform restricts to humans (e.g. Copilot review on GitHub).
- **Mode B inverse:** on a PR the agent authored under shared credentials, the
  absence of a formal `changes_requested` review does NOT mean "no changes
  requested." Every comment the account's human leaves is either a question to
  answer or an implicit change request.
- **Sole-reviewer case.** "MUST NOT request review from self" constrains the
  *request side-effect*, not the loop. When the calling agent is the PR author
  and no eligible non-self human reviewer exists, the agent skips the request
  but does not exit — it keeps polling on the reviewer cadence until the PR
  closes, and the universal `merged → done` terminal handles the eventual
  closure. Terminating early because there's nobody to ask is non-conforming.

## Actionability (§2.2)

The `pr-status` script applies these rules; the agent reads the resulting
`actionable="true|false"`. For reference, a comment or thread is **non-actionable**
iff any of:

- the body is the calling agent's plan comment — a line-anchored
  `<!-- agent-plan:... -->` sentinel AND a comment author matching the calling
  gh identity. The agent edits its plan in place; it never needs to be
  "addressed." (The author match keeps a *human* comment that merely quotes
  the marker actionable.)
- the newest comment was written by the calling agent AND carries a terminal
  signal — matched either by an exact `<!-- agent-reply:$DISPATCH_AGENT_ID -->`
  marker OR by the comment's gh-reported author equalling the calling identity,
  so a drifted agent-id in the marker does not re-actionable the agent's own
  resolved replies.
- the platform has explicitly resolved the thread (threads only).

A human reply after the agent's last turn makes the item actionable again.
An annotation is actionable unless `<cache>/<id>.ack` exists.

## Operational logging (§2.3)

One line per entry:

```
<timestamp> <kind> ticket=<ticket-url> pr=<pr-url> ticket-role=<role> pr-state=<state> | <message>
```

- `<timestamp>`: RFC 3339 with offset, second precision.
- `<kind>`: `TRANSITION` | `WAIT` | `RESUME` | `BLOCK` | `INFO` | `ERROR`.
- `ticket=` / `pr=`: full URLs, never bare IDs; `-` when absent.
- `<pr-state>`: `draft` | `open` | `merged` | `closed`; `-` when no PR.

Kinds `deliver` emits:

| Kind         | When                                                                                    |
| ------------ | --------------------------------------------------------------------------------------- |
| `INFO`       | Heartbeats while monitoring/polling; substantive non-state events.                      |
| `WAIT`       | Entering a poll for an external condition; message names the venue and awaited outcome. |
| `RESUME`     | The awaited condition is met and active work resumes.                                   |
| `ERROR`      | Errors surfaced but not immediately fatal.                                              |
| `TRANSITION` | (Ticket-driven runs only) a ticket role change.                                         |

When a linked ticket's role changes, also post a state-change comment to the PR
(or ticket) following the §2.1 wire format, body exactly:

```
State: <prev-role> → <new-role>
Rationale: <one line; required for corrective and cancel transitions>
```
