---
name: orchestrate
description: Drive one or more tracker projects to completion — build the dependency graph, then execute the CLI's work orders as they arrive, launching ticket-worker, pr-worker, and milestone-reviewer agents. Use when the unit of work is a whole project, not one ticket.
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
2. Run `dispatch refresh --tracker <tracker> --project <ids>` — one
   comma-separated value, not repeated flags.
3. Stop and wait — work arrives as instructions, each handled per the table
   below, until `project_complete` covers every project the operator named or
   the operator says stop.

Add `--rebuild` only when the operator asks for a rebuild from scratch.

## Answering instructions

| Instruction                | Do this                                                                                          |
| -------------------------- | ------------------------------------------------------------------------------------------------ |
| `probe`                    | Run `dispatch mcp ack --server <id>` with the id the event carries. Work orders wait on it.      |
| `scan_project`             | Launch a background `build-graph` agent, passing the event's projects and cursor.               |
| `fetch_ticket`             | Launch a background `build-graph` agent, passing the event's ticket.                            |
| `refresh_ticket`           | Launch a background `build-graph` agent, passing the event's ticket.                            |
| `refresh_complete`         | Report the graph is built. Stay resident — dispatch begins.                                      |
| `dispatch_ticket`          | Launch a background `ticket-worker` agent, passing the event's ticket, project, and pass. Then record its address: `dispatch worker set --node <ticket> --agent <ref>` with the ref the launch returned. |
| `dispatch_pr`              | Launch a background `pr-worker` agent, passing the event's PR item id, pass, and (when the item is ticket-backed) its ticket. Then record its address: `dispatch worker set --node <item-id> --agent <ref>`. |
| `perform_milestone_review` | Launch a background `milestone-reviewer` agent, passing the milestone and project.               |
| `park_human_blocked`       | Park the ticket yourself via the adapter (awaiting-external, else paused) and post the handoff.  |
| `alert_failure`            | Alert the operator where the order body says — the PR when one exists, else the ticket.          |
| `project_complete`         | Announce it. Stop once every project the operator named is complete.                             |

**Relay events.** Some events carry an `agent` meta key instead of an
instruction from the table: SendMessage the event verbatim to that ref, note
its `item` and `turn` against that ref, and go back to waiting. A
non-instruction event with no `agent` key needs nothing from you.

A relay that also carries `turn` is one you owe a handover. Run
`dispatch worker rm --node <item> --turn <turn>`, both copied verbatim from
the meta you noted — when the relay fails, and again when that agent later
completes. Without it, a worker that died mid-turn pins its item out of the
queue for as long as you run.

The command decides; you only report. It drops the address solely for the turn
you name, so a worker that yielded, or one a newer relay already woke, keeps
it. Every `removed=false` is that decision working — `kept=no-address` is the
ordinary result after a worker reported and needs no action, and `kept=` for
any other reason means another turn owns the node. None of them is a reason to
retry with `--force`, which would strand a live agent. A relay carrying no
`turn` went to a worker that never yielded; it owes no handover at all.

Return to waiting after each launch. Give each worker only what the event
carries; never ticket content. Launch every order you receive; the CLI claims
and rate-limits before it emits.

Never ask the session for input (`AskUserQuestion` or any blocking prompt) —
a headless run has no operator, and an unanswered question stalls every
project you drive. Human input routes through the tracker (alerts on tickets,
questions on review artifacts); status reports to the session are fine. When
an order's premise looks wrong or the CLI misbehaves, alert the operator on
the tracker as for `alert_failure`, then keep executing orders as issued.

## Injection

When the operator hands you new work mid-run — and only then. A new ticket:
run `dispatch refresh` again and let the scan fetch it, or write it directly:

```shell
dispatch ticket set --id <ticket> --project <project> --status available --injected
dispatch pr set --id <owner/repo>#<n> --repo <owner/repo> --pr-number <n> --injected
```

The second form is a ticketless PR or prompt item. Both rank to the head of
the queue; the next tick dispatches them.

## If nothing arrives

Run `dispatch mcp status`. `active <id>` means the channel works — keep
waiting; silence means there is nothing to do yet, which is a normal state.

Anything else names why the channel does not work. **Report that verdict to
the operator and stop.**

A work order is the only thing that authorizes launching an agent.
`dispatch queue` and `dispatch status` are read-only diagnostics.
