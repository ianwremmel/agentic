# Dispatch Specification

This document is the top-level table of contents for the Dispatch specification.
Each section links to a narrative file (context, rationale, examples) and a
normative file (formal requirements, wire formats, state machines). The normative
files are authoritative; narrative files inform and explain.

Conformance language follows [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119):
**MUST**, **MUST NOT**, **REQUIRED**, **SHALL**, **SHALL NOT**, **SHOULD**,
**SHOULD NOT**, **RECOMMENDED**, **MAY**, and **OPTIONAL**.

---

## §1 — Introduction

| File                                     | Contents                                                    |
| ---------------------------------------- | ----------------------------------------------------------- |
| [01-introduction.md](01-introduction.md) | Overview, key concepts, architecture, how to read this spec |

---

## §2 — Protocols

### §2.1 — Agent Communication Protocol

| File                                                                      | Contents                                                     |
| ------------------------------------------------------------------------- | ------------------------------------------------------------ |
| [01-narrative.md](02-protocols/01-communication-protocol/01-narrative.md) | Why it exists, modes, venues, review challenge               |
| [02-normative.md](02-protocols/01-communication-protocol/02-normative.md) | Wire format, mode selection, marker syntax, terminal signals |

### §2.2 — PR Status Protocol

| File                                                                  | Contents                                                |
| --------------------------------------------------------------------- | ------------------------------------------------------- |
| [01-narrative.md](02-protocols/02-pr-status-protocol/01-narrative.md) | Why a cached status doc, what it solves, usage patterns |
| [02-normative.md](02-protocols/02-pr-status-protocol/02-normative.md) | XML schema, cache layout, actionability rules           |

### §2.3 — Ticket Workflow Protocol

| File                                                                        | Contents                                                         |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| [01-narrative.md](02-protocols/03-ticket-workflow-protocol/01-narrative.md) | Tracker diversity, abstract vocabulary rationale                 |
| [02-normative.md](02-protocols/03-ticket-workflow-protocol/02-normative.md) | Role/group tables, state machine, log format, decomposition rule |

### §2.4 — Delivery Protocol

| File                                                                    | Contents                                                 |
| ----------------------------------------------------------------------- | -------------------------------------------------------- |
| [01-narrative.md](02-protocols/04-delivery-protocol/01-narrative.md)   | Design goals, stage overview, automation-first rationale |
| [02-normative.md](02-protocols/04-delivery-protocol/02-normative.md)   | Worktree rules, PR-open sequence, CI gates, termination  |

### §2.5 — Ticket Coordination Protocol

| File                                                                            | Contents                                                                      |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| [01-narrative.md](02-protocols/05-ticket-coordination-protocol/01-narrative.md) | Why a coordinator, ticket↔PR mapping, human-handoff, standalone vs dispatched |
| [02-normative.md](02-protocols/05-ticket-coordination-protocol/02-normative.md) | Claiming, decomposition, PR production, role transitions, DoD, reporting      |

### §2.6 — Orchestration Protocol

| File                                                                      | Contents                                                     |
| ------------------------------------------------------------------------- | ------------------------------------------------------------ |
| [01-narrative.md](02-protocols/06-orchestration-protocol/01-narrative.md) | Three tiers, graph-frontier, producers/adapters, injection   |
| [02-normative.md](02-protocols/06-orchestration-protocol/02-normative.md) | Graph document, producer/cursor contract, tick, slots, gates |

---

## §3 — CLI and Channel Server

### §3.1 — Channel Server

| File                                                        | Contents                                                                                                                            |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| [01-narrative.md](03-cli/01-channel-server/01-narrative.md) | Why a channel server, process model, event system, mode selection, multi-session                                                    |
| [02-normative.md](03-cli/01-channel-server/02-normative.md) | Process model (mode marker, session correlation), channel message protocol, event sourcing, multi-session, fallback mode, lifecycle |

### §3.2 — Commands

| File                                                                    | Contents                                                   |
| ----------------------------------------------------------------------- | ---------------------------------------------------------- |
| [01-narrative.md](03-cli/02-commands/01-narrative.md)                   | Role of the command layer; interaction vs server commands   |
| [02-normative.md](03-cli/02-commands/02-normative.md)                   | Server and work-registration commands                      |
| [03-interaction-commands.md](03-cli/02-commands/03-interaction-commands.md) | Interaction primitives (create-comment, react, etc.)   |

---

## Change log

| Date       | Change                                                                                                                                                                                                                                                                      |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-05-12 | Initial spec structure                                                                                                                                                                                                                                                      |
| 2026-05-13 | Added §1; split §3 into daemon and commands                                                                                                                                                                                                                                 |
| 2026-05-13 | Added §2.1–§2.4, §3.1–§3.2; retired all pre-spec source docs                                                                                                                                                                                                                |
| 2026-05-14 | Review feedback: §2.2 adds comments channel, checks precedence; §2.3 fixes milestones and Asana; §2.4 fixes review gating; §3 refactors commands                                                                                                                            |
| 2026-06-07 | Added §2.5 Ticket Coordination + §2.6 Orchestration                                                                                                                                                                                                                         |
| 2026-07-23 | §3.1 reframed from Daemon to per-session Channel Server; added the channel message protocol; §3.2 reframed to server + work-registration commands                                                                                                                           |
| 2026-07-24 | §3.1 mode detection changed to an acknowledgement handshake and the meta-key/body rules corrected against the measured channel preview; `source` corrected to the runner's `plugin:<plugin>:<server>` name and registration restated as three parts including the allowlist |
| 2026-07-24 | §3.1/§3.2 correlate a caller to its own channel server on the runner's session id, so a cold `dispatch mcp status` can select its mode                                                                                                                                      |
