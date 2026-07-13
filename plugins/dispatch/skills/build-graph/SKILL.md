---
name: build-graph
description: Build or refresh the tracker-neutral project dependency graph and emit the project-graph document — the ranked available frontier, blocked and human-blocked sets, milestone gates, anomalies, and completion counts. Use whenever an orchestrator needs to know what is workable right now across one or more projects, on any tracker.
---

# build-graph

You are the **producer**. Fetch project state from the tracker, normalize it,
hand it to the `dispatch` CLI, and emit the document the CLI derives.

**You do not reason about the graph.** Effective-blocking, ranking, cycle
detection, milestone gates, and completion counts are computed by the CLI, so
every consumer sees the same answer. Never decide for yourself that a ticket is
workable, that a milestone is done, or that one ticket outranks another — fetch,
normalize, ingest, emit.

**Running the CLI.** `scripts/dispatch` from the plugin root. It needs no
install: `${CLAUDE_PLUGIN_ROOT}/scripts/dispatch graph …`.

## Tracker adapters

If a `build-<tracker>-graph` skill is installed, **follow it** — it carries the
tracker's real field names, status mapping, and fetch recipe. Today that is
[`build-linear-graph`](../build-linear-graph/SKILL.md).

Without an adapter skill you can still build the graph: fetch the same facts by
whatever means the tracker offers (MCP, CLI, API) and normalize them into the
payload below. The CLI ships default state mappings for `linear`, `github`, and
`asana`.

## Inputs

The caller names the **selected projects** — the projects to sync. There is no
default: syncing "everything" is never implied. If you were not told which
projects, ask (or, when dispatched, read them from the brief).

## The tick

```
1. for each selected project P:
     cursor=$(dispatch graph cursor get --source <tracker>:<P>)
2. fetch:  any cursor empty -> full fetch of every selected project
           all cursors set  -> only what changed since each
3. normalize into ONE payload (all selected projects together)
4. dispatch graph ingest [--full] --tracker <t> --file payload.json
5. dispatch graph doc          # the project-graph document, on stdout
```

**Keep one cursor per project**, named `<tracker>:<project-id>`, and carry them
in the payload's `cursors` object. A single shared cursor is wrong once you sync
more than one project: the newest timestamp from project A would be used as the
changed-since bound for project B, silently skipping B's older changes.

## Exclusions

Work the orchestrator already owns must never be handed out again. It records
that with exclusions, and the frontier honors them:

```
dispatch graph exclude add --id <ticket> --kind in-flight|done|failed
dispatch graph exclude remove --id <ticket>
```

- `in-flight` — a coordinator is on it now. Off the frontier; still counted as
  outstanding.
- `done` — the orchestrator has finished with it. Off the frontier. It does
  **not** overwrite the ticket's tracker role, so a merged-but-unverified ticket
  still holds its project open.
- `failed` — it will not progress. Its dependents become `permanently-blocked`
  rather than waiting forever.

An exclusion never suppresses a ticket's node updates: an excluded ticket keeps
being fetched and re-ingested, so the cache cannot go stale on work in flight.

`--full` **replaces the whole graph**, not one project — so a full sync is a
single payload covering *every* selected project at once. Never run
`ingest --full` per project in a loop: the second call would wipe the first. On a
delta, omit `--full`; the fetch is merged.

Write the payload to a file and pass `--file`; do not pipe a hand-built JSON
string through the shell, where quoting can corrupt it.

A cursor is opaque — store it and hand it back unchanged, never interpret it.

## Ancestors outside the selected projects

A ticket's blocker can live in a project you were not asked to sync. Fetch those
ancestors anyway — otherwise the CLI reports a `dangling-edge` anomaly and holds
the dependent blocked, which is safe but stalls real work.

Walk **upward only**: for an out-of-scope ancestor, fetch its state and its
`blockedBy`, and do **not** declare its `blocks`. Declaring what a foreign ticket
blocks drags in its descendants, which drag in theirs — chasing the closure of the
whole workspace. Repeat until no new ancestors appear.

Their projects appear in the document marked `partial="true"`: only some of their
tickets were ever fetched, so their counts are not a statement about that project
and they are never `terminal`. Do not carry a cursor for a partial project — you
did not sync it.

If you cap the walk, say so, and expect the residual `dangling-edge` anomalies.
The affected dependents stay blocked, which is the safe failure.

## Payload

One JSON object. Keys are accepted in camelCase or snake_case.

| Field          | Meaning                                                                                    |
| -------------- | ------------------------------------------------------------------------------------------ |
| `cursors`      | `{"<tracker>:<project-id>": "<token>"}` — one changed-since token per project synced.      |
| `projects[]`   | `id`, `name`. List every **selected** project. Omit ancestors' projects; they are partial. |
| `milestones[]` | `id`, `project`, `name`, `sortOrder` (ascending display order).                            |
| `nodes[]`      | One per ticket — see below.                                                                |

Each node:

| Field              | Required | Meaning                                                                       |
| ------------------ | -------- | ----------------------------------------------------------------------------- |
| `id`               | yes      | The tracker's identifier, e.g. `CLC-945`.                                     |
| `project`          | yes      | Project id.                                                                    |
| `state`            | yes\*    | The tracker's **native** state name. The CLI maps it to a role.               |
| `role`             | —        | A resolved protocol role. Use instead of `state` only if you are certain.     |
| `url`, `title`     | —        | As the tracker gives them.                                                     |
| `milestone`        | —        | Milestone id, or omit.                                                         |
| `labels[]`         | —        | Plain strings. Drive `human-interactive` and `verification` (see below).       |
| `priority`         | —        | **Lower is more urgent.** Normalize the tracker's scale. Omit if none.        |
| `branchHint`       | —        | The tracker's suggested branch name, if it has one.                           |
| `blockedBy[]`      | —        | Ids of the tickets blocking this one.                                          |
| `blocks[]`         | —        | Ids of the tickets this one blocks.                                            |
| `updatedAt`        | —        | The tracker's timestamp.                                                       |
| `injected`         | —        | `true` for runtime-injected work: ranks to the top of the frontier.           |
| `deleted`          | —        | `true` to remove the ticket. Needs only `id`.                                  |

\* Either `state` or `role`.

**Edges: an empty array and an absent key mean different things.** `"blockedBy": []`
clears the ticket's blockers; omitting `blockedBy` says *this fetch has nothing
to say about them* and leaves the stored edges alone. Declare both directions for
every ticket **in a selected project**, so an edge is recorded from whichever
endpoint changed — but only `blockedBy` for an out-of-scope ancestor (see above).

Sub-task / parent hierarchy is **not** a dependency and must not become an edge.
A parent's relationship to its subtasks is the coordinator's business, not the
graph's. Only the tracker's blocking relation is an edge.

**Target kind** is derived from labels: a `human-led` / `human-interactive` label
makes the ticket `human-only` (a human does it; no coordinator is ever
dispatched), a `verification` label makes it `verification` (no code change).
Everything else is a `pr`. Override with an explicit `targetKind` only when the
labels are wrong. Configure the label names in the config file
([`reference.md`](./reference.md#config-file)).

## Rules

- **Never invent a role.** If the CLI exits 4 with "no mapping for the native
  state X", the tracker has a state nobody has mapped. Do not guess which role it
  means and do not fall back to `available` — a wrong guess silently strands work
  or dispatches it twice. Add the mapping to the config file if the meaning is
  unambiguous; otherwise escalate to the operator with the state's name.
- **Fetch every ancestor.** A `dangling-edge` anomaly means an edge names a
  ticket you did not fetch. An unfetched blocker propagates like any other, so
  the dependent is held blocked rather than dispatched behind a blocker nobody
  can see. Fetch the missing tickets (see above).
- **Surface anomalies; never work around them.** A `cycle` is illegal, and
  `cross-project-reverse` means two projects block each other. Report them to the
  operator. Do not "resolve" one by dropping an edge.
- **A full sync is the recovery path.** Use it on first run, after any loss of
  local state, or when a delta looks inconsistent.
- **Report an empty frontier honestly.** If nothing is `available`, say why from
  the counts rather than reaching for work anyway. A project whose tickets are all
  `dormant` (in the tracker's backlog) has nothing to dispatch: it needs a human
  to promote tickets, not an agent to pick one. An empty frontier is **not**
  completion — `terminal="false"` still means work remains.
- **Booleans are booleans.** `"deleted": "true"` is a string and is rejected. A
  quietly-ignored `deleted` flag would resurrect a ticket you meant to remove.

## Output

`dispatch graph doc` writes the project-graph document to stdout (XML by default,
`--format json` if you would rather not parse XML). Logs are logfmt on stderr, so
stdout stays clean to pipe or capture.

The derived sections — `available` (ranked), `blocked`, `human-blocked`,
`permanently-blocked`, `milestones`, `counts`, `anomalies` — are **authoritative**.
A consumer reads them; it does not re-derive them from `nodes` and `edges`, which
are carried for context.

Section meanings, ranking, milestone gating, the config file, and exit codes are
in [`reference.md`](./reference.md).
