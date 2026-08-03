---
name: orchestrate
description: Drive one or more tracker projects to completion — build the dependency graph, then execute the CLI's work orders as they arrive, launching ticket-worker, prompt-worker, and milestone-reviewer agents. Use when the unit of work is a whole project, not one ticket.
---

# orchestrate

**The CLI decides; you execute.** Never work out which tickets are missing,
what to dispatch next, or whether anything is complete — every decision
arrives as an instruction, and you answer it. You never read ticket bodies or
judge CI state; workers do.

The `dispatch` commands below are also tools on the plugin's MCP server
(`mcp ack` → the `mcp_ack` tool). When the server is attached, call the tools:
the server pushes queued instructions after each tool call.

**In plan mode, decline** and ask the operator to re-invoke outside it — this
skill launches agents and writes state.

## Start

1. Resolve each project name the operator gave to its project id. Load
   `tracker-adapter-${user_config.tracker}` and use its lookup; without an
   adapter, drive the tracker's MCP server directly.
2. Run `dispatch refresh --tracker <tracker> --project <project-ids>`.
3. Stop and wait — work arrives as instructions, each handled per the table
   below, until `project_complete` covers every project the operator named or
   the operator says stop.

Add `--rebuild` only when the operator asks for a rebuild from scratch.

## Answering instructions

| Instruction                | Do this                                                                                          |
| -------------------------- | ------------------------------------------------------------------------------------------------ |
| `probe`                    | Run `dispatch mcp ack --server <id>` with the id the event carries. Work orders wait on it.      |
| `scan_project`             | Run [`build-graph`](../build-graph/SKILL.md) for the projects and cursor named.                  |
| `fetch_ticket`             | Run [`build-graph`](../build-graph/SKILL.md) for the single ticket named.                        |
| `refresh_complete`         | Report the graph is built. Stay resident — dispatch begins.                                      |
| `dispatch_ticket`          | Launch a background `ticket-worker` agent, passing the event's ticket, project, and pass.        |
| `dispatch_pr`              | Launch a background `prompt-worker` agent, passing the event's PR item id and pass.              |
| `perform_milestone_review` | Launch a background `milestone-reviewer` agent, passing the milestone and project.               |
| `park_human_blocked`       | Park the ticket yourself via the adapter (awaiting-external, else paused) and post the handoff.  |
| `alert_failure`            | Alert the operator on the ticket via the adapter; recovery is tracker-side.                      |
| `project_complete`         | Announce it. Stop once every project the operator named is complete.                             |

Return to waiting after each launch. Give each worker only what the event
carries plus the credential context; never ticket content. Launch every order
you receive; the CLI claims and rate-limits before it emits.

Human input routes through the tracker (alerts on tickets, questions on
review artifacts), never by blocking on session input. Status reports to the
session are fine.

## Injection

Mid-run work arrives through the store. A new ticket: run `dispatch refresh`
again and let the scan fetch it, or write it directly with
`dispatch ticket set --injected`. A ticketless PR or prompt item:
`dispatch pr set --id o/r#7 --repo o/r --pr-number 7 --injected`. Both rank to
the head of the queue; the next tick dispatches them.

## If nothing arrives

Run `dispatch mcp status`. `active <id>` means the channel works — keep
waiting. Anything else names why it does not; fall back to polling on a
self-paced loop: `dispatch refresh status --tracker <tracker>` for unanswered
fetch instructions, then `dispatch queue` and `dispatch status` for
dispatchable work and open conditions, handling each exactly as the table
above does. `terminal=true` from `dispatch status` is completion in this
fallback.
