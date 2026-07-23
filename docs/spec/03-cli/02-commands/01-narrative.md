# §3.2.1 — Commands: Narrative

## Role of the command layer

The `dispatch` CLI has two distinct roles.

**Server and work-registration commands** run and inspect the channel server
(§3.1) and register work into the graph for it to monitor. These are commands a
developer runs from the terminal; the session runner spawns `dispatch mcp`
itself.

**Interaction commands** are the primitives the protocols depend on for every
platform write the agent makes — posting a comment, reacting to a thread,
requesting a review, querying PR state. These are called from within an agent
session, not by the operator directly.

Separating these into explicit CLI subcommands — rather than calling platform
APIs directly — achieves three things:

1. **Protocol compliance is enforced at the call site.** A `dispatch
   create-comment` call automatically applies the §2.1 wire format (machine
   marker, sparkle wrapper in Mode B). An agent that uses the command can't
   accidentally omit the marker.

2. **Platform differences are absorbed.** The agent asks for a comment; the
   command handles whether the platform uses a REST API, a GraphQL mutation, or a
   CLI invocation. The agent's prompt never contains platform-specific branching.

3. **Auditability.** Because every write goes through a known command, platform
   interactions are logged centrally. Session logs show `dispatch create-comment`
   calls, not raw API calls that could vary across implementations.

## Interaction commands and the protocols

The interaction commands are the implementation of §2.1 (communication protocol)
and §2.2 (PR status protocol) at the CLI layer. Specifically:

- `dispatch create-comment` and `dispatch reply-to-thread` implement §2.1's
  write rules (machine marker, Mode B sparkle wrapper, writing rules table).
- `dispatch react` implements §2.1's terminal and non-terminal signals.
- `dispatch request-review` implements §2.1's review rules.
- `dispatch pr-status` implements §2.2's status script contract: it emits the
  XML document on stdout and manages the disk cache.
- `dispatch ack-annotation` writes the `.ack` marker described in §2.2.

An agent session that uses these commands for all platform writes is guaranteed
to conform to §2.1 and §2.2 without needing to re-implement mode selection,
marker syntax, or cache layout.

## Server vs interaction: who calls what

Server and work-registration commands (`mcp status`, the `graph` surface,
`graph pr add`) are invoked by the operator from the terminal, or by a skill to
register work; the session runner spawns `dispatch mcp` itself. They manage the
server and the graph.

Interaction commands (`create-comment`, `reply-to-thread`, `react`,
`request-review`, `pr-status`, `ack-annotation`) are invoked by an agent session
in response to protocol obligations. They are available as terminal commands so
any runner (Claude Code, a custom runner, a test harness) can use them without
a language-specific SDK dependency.
