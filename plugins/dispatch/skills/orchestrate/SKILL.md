---
name: orchestrate
description: Build a tracker project's dependency graph — start a refresh, then answer the CLI's fetch instructions until it reports the graph complete. Use when asked to orchestrate, plan, or graph a whole project rather than one ticket.
---

# orchestrate

**The CLI decides what to fetch. You fetch it.** Never work out which tickets
are missing, whether a scan is complete, or what to do next — answer the
instruction.

The `dispatch` commands below are also tools on the plugin's MCP server
(`refresh status` → the `refresh_status` tool). When the server is attached,
call the tools: the server pushes queued instructions after each tool call, so
a shell write leaves its instructions queued until the next tool call or a
status check.

## Start

1. Resolve the project name the operator gave to its project id. Load
   `tracker-adapter-${user_config.tracker}` and use its lookup; without an
   adapter, drive the tracker's MCP server directly.
2. Run `dispatch refresh --tracker <tracker> --project <project-ids>`.
3. It acks. Stop and wait — work arrives as instructions.

Add `--rebuild` only when the operator asks for a rebuild from scratch.

## Answering instructions

| Instruction        | Do this                                                                         |
| ------------------ | ------------------------------------------------------------------------------- |
| `scan_project`     | Run [`build-graph`](../build-graph/SKILL.md) for the projects and cursor named. |
| `fetch_ticket`     | Run [`build-graph`](../build-graph/SKILL.md) for the single ticket named.       |
| `refresh_complete` | Stop. Report the graph is built, with the project ids and a ticket count.       |

An empty frontier, a quiet stretch, or a scan that found no tickets are not
completion — only `refresh_complete` is.

## If nothing arrives

Run `dispatch refresh status --tracker <tracker>` — it prints the state and every
outstanding instruction. Answer them the same way and re-run it. In this
fallback no `refresh_complete` event will arrive; when status reports `idle`
with nothing outstanding, the refresh has closed — report completion as above.
