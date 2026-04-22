# Agent Communication Protocol

Status: draft
Scope: every plugin in this marketplace whose agents post to a PR or a
ticket surface. Today that's `pull-requests` (PR issue comments, PR
inline review comments, reactions) and `linear` (ticket comments).
The protocol is tracker-agnostic — it applies equally to GitHub
issues, Linear, Jira, Asana, or any other issue tracker a plugin
integrates with. This doc defines the wire format those posts MUST
follow so that humans and agents can both read the stream without
confusion.

## Why this exists

Agents talk to humans in three venues:

1. **PR issue comments** — the top-level comment stream on a GitHub PR.
2. **PR inline review comments** — threads anchored to a file and line.
3. **Ticket comments** — comments on an issue in whatever tracker the
   plugin integrates with (GitHub Issues, Linear, Jira, Asana, …).

A fourth venue — the in-product chat inside the Claude Code client
(web, desktop, iOS/macOS) — is **not** covered by this protocol and
MUST NOT substitute for it. See "Claude Code on the web" below.

Two facts make this awkward:

- The same comment stream is read by humans (who want to know who wrote
  what) and by other agents (which need to skip their own writes when
  polling for new work, to avoid feedback loops).
- An agent may be authenticated as a dedicated bot identity, or it may be
  authenticated as a human — usually the human who kicked off the session.
  In the second case the account byline gives the reader no hint that the
  agent, not the human, produced the text.

The protocol fixes both by requiring every agent-authored post to carry
a **machine-readable marker** (always) and, when the account doesn't
already signal "this is an agent," a **visible marker** (sparkles) so a
human reader can tell at a glance.

## Environments

These are the runtime environments we expect the protocol to handle.
The mode column is determined purely by the credentials the client
gives the agent — nothing about the environment itself changes the
rules.

| # | Environment | Auth | Mode |
| --- | --- | --- | --- |
| 1 | Claude Code CLI on laptop | user's GitHub / tracker creds | B (human-credentialed) |
| 2 | Claude Code on the web | user's GitHub / tracker creds | B (human-credentialed) |
| 3 | Claude Code in a sandbox | dedicated `ai-agent` identity | A (agent-credentialed) |
| 4 | Claude Code iOS / macOS app | user's GitHub / tracker creds | B (human-credentialed) |

Scenarios 1, 2, and 4 must post through the user's account with the
sparkle wrap so the human can distinguish their own comments from
their agent's. Scenario 3 posts through a dedicated bot account and
therefore needs only the HTML marker.

### Claude Code on the web

Today Claude Code on the web tends to reply to a PR or ticket event
by writing to the in-product chat only. **That is not compliant with
this protocol.** When the web client is subscribed to a PR or ticket
and answers a comment event, the reply MUST be posted into the
originating venue (PR issue comment, PR inline thread, or ticket
comment) through the same `wrap_agent_body` write path the CLI uses.
The in-product chat MAY additionally mirror the reply, but it cannot
be the sole destination — anyone who is not looking at Claude Code at
that moment would never see the response.

## Modes

Every agent post is produced in exactly one of two modes. The mode is
determined at write time from the credentials the agent currently holds;
it is NOT a config switch.

### Mode A — Agent-credentialed

The agent holds credentials for an identity that is obviously not a
human teammate. On GitHub that means either:

- `GET /user` returns `type == "Bot"`, or
- `type == "User"` but the login matches `*copilot*`, `*codex*`,
  `*claude*`, or `*ai-agent*` (case-insensitive).

On any other tracker (Linear, Jira, Asana, …) the equivalent is a
service-account / OAuth-app / API-key identity whose display name or
email local-part matches the same agent-name patterns, or which the
tracker explicitly types as a bot / integration.

In this mode the byline itself tells readers the author is an agent, so
no visible wrapper is added. Only the machine-readable marker is
needed.

### Mode B — Human-credentialed

The agent is using credentials that the venue will display as a human
teammate. On GitHub: `GET /user` returns `type == "User"` and the
login does not match any of the agent-name patterns above. On other
trackers: the identity is a normal user seat whose display name /
email local-part does not match an agent pattern.

In this mode the byline looks exactly like a human comment. The
protocol requires a **visible sparkle block** around the body so a
reader skimming the thread can tell the agent authored it.

### Detection

Every plugin MUST implement a single `is_human_auth` predicate for its
venue. The reference implementation for GitHub is:

```bash
is_human_auth() {
  # "User" + login not matching any known agent-name pattern
  # Reference implementation lands with #3 in
  # plugins/pull-requests/scripts/lib/gh-auth.bash.
}
```

For any other tracker, the predicate probes that tracker's "who am I"
endpoint (e.g. Linear `viewer`, Jira `myself`, Asana `users/me`) and
applies the same rule: bot-typed identity → Mode A; otherwise check
the human-readable name / email local-part against the agent-name
patterns above.

Detection must be best-effort safe: if the identity call fails (rate
limit, network, unauthenticated), treat the mode as Mode A (no sparkle
wrap). Rationale: losing the visible marker is a readability bug;
adding sparkles to a legitimate human author would corrupt their
comment.

## Wire format

Every agent post MUST be produced by a single helper (`wrap_agent_body`
or its per-tracker equivalent) so the format stays consistent across
plugins.

### Mode A (agent-credentialed)

```
<!-- agent-reply -->
{body}
```

### Mode B (human-credentialed)

```
<!-- agent-reply -->
✨

{body}

✨
```

- The HTML comment `<!-- agent-reply -->` is the machine marker. It
  MUST be on its own line at the start of the body. It MUST be
  present in both modes.
- The `✨` (U+2728) lines bracket the body with one blank line of
  padding on each side. This is the visible marker. It MUST be
  present in Mode B and MUST NOT be present in Mode A.
- The body itself is unchanged Markdown. Agents must not embed the
  marker or sparkle sentinels inside the body.

### Ticket comments

Trackers vary in how they store and render comment bodies:

- **GitHub Issues** — Markdown with HTML passthrough. Same format as
  PR comments, no special handling.
- **Linear** — Markdown; raw HTML is stripped in the rendered view
  but the source markdown returned by the API preserves the
  `<!-- agent-reply -->` line, so polling still works.
- **Jira** — Atlassian Document Format (ADF) or wiki markup
  depending on endpoint. The HTML-comment marker is not preserved;
  plugins MUST define an alternative machine marker (see below).
- **Asana** — HTML-subset rich text. HTML comments are not
  preserved; same requirement as Jira.

When a tracker strips HTML comments from the stored body, the plugin
integrating with it MUST define an alternative machine marker and
document it in a sibling doc that this file links to. Acceptable
alternatives, in order of preference:

1. A dedicated custom field / property on the comment object
   (e.g. Jira comment `properties`) that stores
   `{"agent-reply": true}`.
2. A trailing fenced block of the form
   ```
   <!-- /agent-reply --> (or whatever the tracker preserves verbatim)
   ```
   at the end of the body.
3. An invisible marker made of zero-width joiners / variation
   selectors. Least preferred because it's easy to break in
   round-trip editing.

The sparkle wrap (`✨ … ✨`) renders correctly on every tracker we
support today and MUST still be used in Mode B regardless of which
machine marker the tracker can preserve.

## Read side

Any poll / watch loop — including the event subscription that Claude
Code on the web uses — that reads a comment stream MUST:

1. Filter out posts carrying the agent-reply marker (the HTML comment
   on GitHub; the tracker-specific equivalent elsewhere). These are
   the agent's own writes; surfacing them would feed the agent its
   own output.
2. Keep posts from Copilot (`user.login == "copilot"`) even though
   Copilot is a bot — it acts as a reviewer whose comments the agent
   needs to read.
3. Otherwise filter out `user.type == "Bot"` (or the tracker
   equivalent) authors to ignore routine automation (CI bots,
   Dependabot status, tracker system messages, etc.) unless a plugin
   opts in to a specific bot.

The web client's event-subscription path MUST route each observed
comment through the plugin's normal response flow, ending in a write
to the originating venue via `wrap_agent_body`. Writing only to the
in-product chat is a protocol violation.

## Reactions as terminal signals

GitHub reactions are the protocol for "the agent has finished with
this comment." They MUST be used only to close the loop, not to
editorialize.

| Reaction | Meaning |
| --- | --- |
| `+1` | Addressed / agreed / done. |
| `-1` | Rejected — with an accompanying inline or issue reply that explains why. |
| `rocket` | Shipped / merged / applied. |
| `eyes` | Non-terminal acknowledgement — agent has seen the comment and is working on it. |

`+1`, `-1`, and `rocket` are **terminal**: the poll loop skips any
comment that carries one of these reactions from the agent's own
login. `eyes` is explicitly non-terminal and does not suppress the
comment on the next poll.

Agents MUST NOT use `heart`, `hooray`, `laugh`, or `confused` as
protocol signals. Those reactions are reserved for humans.

Trackers that don't support reactions (Linear, Jira, Asana, and
most non-GitHub venues) need an equivalent terminal signal. The
protocol requires a short, recognizable closing line at the end of
the reply body:

| Terminal token | Meaning |
| --- | --- |
| `Done.` | Addressed / agreed (equivalent to `+1`). |
| `Declined.` | Rejected — with the explanation immediately above (equivalent to `-1`). |
| `Shipped.` | Shipped / merged / applied (equivalent to `rocket`). |

The token MUST be the last non-empty line of the body, on its own
line, so polling can detect it with a suffix match. `eyes` has no
text equivalent — non-terminal acknowledgement on these trackers is
just the absence of a closing token.

Plugins MAY extend this list but MUST NOT repurpose the three tokens
above for other meanings.

## Write side

Every agent write goes through one of these endpoints:

| Venue | API | Plugin entry point |
| --- | --- | --- |
| PR issue comment | `POST /repos/:o/:r/issues/:n/comments` (via `gh pr comment`) | `orchestrate reply --issue <pr> <body>` |
| PR inline reply | `POST /repos/:o/:r/pulls/:n/comments/:id/replies` | `orchestrate reply --inline <pr> <comment_id> <body>` |
| Reaction | `POST /repos/:o/:r/{pulls\|issues}/comments/:id/reactions` | `orchestrate react <id> <reaction> --type inline\|issue` |
| GitHub Issue comment | `POST /repos/:o/:r/issues/:n/comments` | (per-plugin) |
| Linear comment | `commentCreate` mutation | (per-plugin) |
| Jira comment | `POST /rest/api/3/issue/:id/comment` | (per-plugin) |
| Asana story | `POST /tasks/:id/stories` | (per-plugin) |

All write paths MUST run the body through `wrap_agent_body` (or the
plugin's per-tracker equivalent) before posting. Callers MUST NOT
bypass the wrapper — not even for "just a one-liner" — so that the
marker and mode are never forgotten.

## Review requests and token rotation

Requesting a review is a write action that looks like a comment event
to the recipient but does not itself carry a body. The mode rules
don't apply (there's nothing to wrap), but auth still matters:

- **Copilot review**: allowed from a human account; usually rejected
  from a bot account. The `review copilot` subcommand detects Mode A
  and rotates in `GH_REVIEW_REQUEST_TOKEN` for the duration of the
  call. The rotation happens inside a subshell so `GH_TOKEN` never
  leaks into the caller.
- **Human review**: skipped when the agent is authenticated as that
  same human — GitHub rejects self-reviews, and it's a confusing
  thing to ask for.

## Plugin checklist

A new plugin that posts to humans must:

- [ ] Use `wrap_agent_body` (or a documented per-tracker equivalent)
      for every write.
- [ ] Implement `is_human_auth` (or a documented per-tracker
      equivalent) and treat detection failure as Mode A.
- [ ] Filter the agent-reply marker in every poll / event-subscription
      loop. If the web client subscribes to events for this venue,
      ensure replies are posted back into the venue, not only to the
      in-product chat.
- [ ] On GitHub, use only the four documented reactions, with `+1`
      / `-1` / `rocket` as terminal and `eyes` as non-terminal.
      On trackers without reactions, use the `Done.` / `Declined.`
      / `Shipped.` closing tokens.
- [ ] Document any venue-specific deviations (e.g. a tracker that
      strips HTML comments, or a novel machine marker) in a sibling
      doc linked from this file.

## Open questions

- **Per-tracker markers.** Confirm which trackers preserve
  `<!-- agent-reply -->` verbatim and which strip it. Jira and
  Asana almost certainly strip; Linear preserves in the API
  payload even though it doesn't render. Each tracker-specific
  plugin owns picking from the fallback list above and documenting
  the choice.
- **Cross-venue watermarking.** The `pull-requests` plugin stores
  comment watermarks in a `clc-progress` YAML block embedded in the
  PR body. Trackers without a long-lived body field (Linear, Jira,
  Asana, …) need either a separate state file or a dedicated
  custom field. Pick one per tracker and document it.
- **Web-client wiring.** Claude Code on the web currently tends to
  reply in the in-product chat when it receives a PR/ticket event.
  Work needed: wire the event subscription into the same
  `wrap_agent_body` write path used by the CLI so replies land in
  the originating venue. Track separately from this protocol doc.
- **Multi-agent disambiguation.** The marker tells readers "an
  agent wrote this" but doesn't tell them which agent. If we ever
  run two agents against the same PR/ticket concurrently we'll want
  to extend the marker to `<!-- agent-reply:<agent-id> -->` (or
  the equivalent on other trackers) and update the poll-side
  filter accordingly.
