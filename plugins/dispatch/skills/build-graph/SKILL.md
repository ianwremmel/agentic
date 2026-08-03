---
name: build-graph
description: Answer one project-graph fetch instruction — scan a project's tickets, or fetch one ticket, and record what you find through the dispatch CLI. Use when a scan_project or fetch_ticket instruction arrives.
---

# build-graph

You handle **one instruction**. Fetch what it names, write what you find, and
stop. Do not decide what to fetch next, chase a dependency you noticed, or judge
whether the graph is complete — the CLI does all three and will send another
instruction if it needs one.

The `dispatch` commands below are also tools on the plugin's MCP server
(`ticket set` → the `ticket_set` tool). When the server is attached, call the
tools — the server delivers follow-up instructions after tool calls.

## The adapter

Read `tracker-adapter-${user_config.tracker}` first: it supplies the tools, the
field mapping, and the tracker's state → status table. A project on a different
tracker loads `tracker-adapter-<id>` for that tracker. Without an adapter, drive
the tracker's MCP server directly and map its fields onto the flags below
yourself.

## `scan_project`

Fetch every ticket in the named projects. When the instruction carries a cursor,
fetch only what changed since it. Do not filter further — a ticket you skip
becomes a placeholder the CLI has to ask for one at a time.

Write as you go, one command per item so a bad one fails only itself:

```shell
dispatch project set   --id P --name "Platform" --tracker linear
dispatch milestone set --id M1 --project P --name "M1"
dispatch ticket set    --id CLC-945 --project P --status in-progress \
    --title "…" --url "…" [--priority 2] [--labels infra,qa]
dispatch edge add      --blocker CLC-944 --blocked CLC-945
```

Then report the scan complete, passing the tracker's own change token:

```shell
dispatch refresh done --tracker linear --cursor <token>
```

## `fetch_ticket`

Fetch the one ticket named and write it with `ticket set`. If the tracker has no
such ticket — deleted, or on a different tracker — say so instead:

```shell
dispatch ticket missing --id CLC-944
```

Never guess a ticket into existence to clear an instruction.

## Writing rules

- **You map the state; the CLI knows only the vocabulary.** `--status` takes
  `backlog`, `paused`, `awaiting-external`, `available`, `in-progress`,
  `in-review`, `finished`, `delivered`, `verified`, or `canceled`. The adapter
  carries the tracker's table and the rule for a state it does not cover: map it
  only when the lifecycle meaning is unambiguous, otherwise ask the operator.
  Never guess.
- **A milestone is joined by an edge.** `edge add --blocker CLC-945 --blocked M1`
  puts CLC-945 in milestone M1. Milestones are sequenced the same way:
  `edge add --blocker M1 --blocked M2` means M2's work waits on M1.
- **Redeclare a direction with `edge set`.** After re-fetching a ticket's
  blockers, `edge set --node CLC-945 --direction blockers --others a,b` makes
  them exactly `{a,b}` (empty clears them). Use it instead of diffing.
- **An edge that would close a cycle is refused.** Fix the direction, or remove
  the opposing edge first.
- **A delta writes only what changed.** A ticket you don't touch keeps its state.
  Use `ticket rm` only when the fetch shows it gone.

Full flags: [`reference.md`](./reference.md).
