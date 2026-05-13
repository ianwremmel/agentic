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
| [02-normative.md](02-protocols/01-communication-protocol/02-normative.md) | Wire format, mode detection, marker syntax, terminal signals |

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

### §2.4 — Do-Work Protocol

| File                                                                | Contents                                                 |
| ------------------------------------------------------------------- | -------------------------------------------------------- |
| [01-narrative.md](02-protocols/04-do-work-protocol/01-narrative.md) | Design goals, stage overview, automation-first rationale |
| [02-normative.md](02-protocols/04-do-work-protocol/02-normative.md) | Worktree rules, PR-open sequence, CI gates, termination  |

---

## §3 — CLI and Daemon

### §3.1 — Daemon

| File                                                | Contents                                                       |
| --------------------------------------------------- | -------------------------------------------------------------- |
| [01-narrative.md](03-cli/01-daemon/01-narrative.md) | Why a daemon, process model, event system, prompt system       |
| [02-normative.md](03-cli/01-daemon/02-normative.md) | Process model, spawn contract, event taxonomy, state directory |

### §3.2 — Commands

| File                                                  | Contents                                                  |
| ----------------------------------------------------- | --------------------------------------------------------- |
| [01-narrative.md](03-cli/02-commands/01-narrative.md) | Role of the command layer; interaction vs daemon commands |
| [02-normative.md](03-cli/02-commands/02-normative.md) | Full reference for all dispatch CLI commands              |

---

## Change log

| Date       | Change                                                       |
| ---------- | ------------------------------------------------------------ |
| 2026-05-12 | Initial spec structure                                       |
| 2026-05-13 | Added §1; split §3 into daemon and commands                  |
| 2026-05-13 | Added §2.1–§2.4, §3.1–§3.2; retired all pre-spec source docs |
