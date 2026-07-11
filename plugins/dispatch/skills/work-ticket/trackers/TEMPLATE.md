# Tracker adapter — <tracker name>

This file is the skeleton for writing an adapter, and is not itself one — the
skill skips it when it lists the adapter directories. Copy it to
`<tracker-id>.md` in one of those directories (the search path is in
[`SKILL.md`](../SKILL.md), under Tracker) and fill it in. The skill reads nothing
else about your tracker, so anything it must know to work the ticket belongs
here. Adapters do not merge: to change one row of a bundled adapter, copy the
whole file and edit the copy.

## Identity

| Field        | Value                                                                   |
| ------------ | ----------------------------------------------------------------------- |
| tracker id   | the file's basename                                                     |
| ticket URLs  | the URL shape whose tickets this adapter owns — the skill matches on it |
| ticket ids   | the bare-id shape, if the tracker has one                               |
| access       | the MCP server, CLI, or API the operations below use                    |
| own identity | the call that returns the acting account                                |

## Role map

Every native state the skill can encounter, mapped to exactly one group and — for
every state it must read or write — one role. Roles and groups:
[`reference.md`](../reference.md#lifecycle-roles). `available`, `in-progress`,
`verified`, and `canceled` MUST be mapped; a tracker that cannot express one of
them cannot be adapted.

| Native state | Group | Role |
| ------------ | ----- | ---- |
|              |       |      |

Rules are read **first-match, in order**. Where a role is *computed* from
metadata (a linked PR's state, a close reason, an assignee) rather than stored in
a state field, write the predicate in the Native state column instead of a name,
and order the rows so the most specific matches first. Where two layers can carry
state (a board field over the item's own state), spell the precedence out as
ordered rows — the skill does not infer it.

Say which roles you leave unmapped and what follows: no `finished` (or no
`delivered`) collapses the forward path over it; no `paused` /
`awaiting-external` makes a park an `ERROR`.

## Operations

Bind every operation. A `transition` binding may vary by target role — give a
binding per stored role and `computed` for a role the tracker derives rather than
stores. `unsupported` is legal for `react`, `subtask`, `blocks edge`, and
`one-edge neighbors`; each has a fallback in
[`reference.md`](../reference.md#operations). Leaving any other operation unbound
means the tracker cannot be worked.

| Operation          | Binding |
| ------------------ | ------- |
| fetch brief        |         |
| resolve role       |         |
| own identity       |         |
| claim guard        |         |
| assign self        |         |
| transition         |         |
| ticket comment     |         |
| read comments      |         |
| react              |         |
| file ticket        |         |
| subtask            |         |
| blocks edge        |         |
| one-edge neighbors |         |

## Quirks

Constraints the skill must respect: writes the tracker refuses, transitions it
performs atomically as a side effect, roles it cannot express, rate limits worth
knowing. Omit the section if there are none.
