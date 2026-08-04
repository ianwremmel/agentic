# §2.6.1 — Orchestration Protocol: Narrative

## Why orchestration

Driving a whole project — or several at once — means working many tickets that
sit in a dependency graph: some ready, some blocked, some needing a human, some
gated behind a milestone review. The work spans hours or days and dozens of
tickets. Holding all of that in one agent's context exhausts it long before the
project finishes — and almost none of it is judgment. Which ticket is
unblocked, who may start, whether a milestone gate is open: each has exactly
one correct answer for a given graph.

So the protocol puts the scheduling in **deterministic code**. The `dispatch`
CLI owns the graph, derives the frontier, claims work, accounts for compute
capacity, and pushes **work orders** into the session over the channel
(§3.1.2). Agents do only what needs judgment: fetching and mapping tracker
state, implementing tickets, reviewing milestones, talking to humans.

## The actors

| Actor                    | Owns                                                                     | Defined in |
| ------------------------ | ------------------------------------------------------------------------ | ---------- |
| channel server           | the graph, scheduling, claims, slots, work-order emission                | §3.1       |
| orchestrate session      | relaying: answer instructions, launch workers, make delegated tracker writes | §2.6   |
| ticket-worker agent      | one ticket's coordination — brief, transitions, decomposition, verification | §2.5    |
| pr-worker agent          | one PR item's implementation, bare or ticket-backed                      | §2.4       |
| milestone-reviewer agent | one milestone's review when its gate is ready                            | §2.6       |

The orchestrate session is the resident context the server pushes to. It holds
no schedule and derives nothing: every event either names an agent to launch
or a tracker write to make. Workers are launched as background agents, one per
work order, and report back through `dispatch` commands — the same writes the
server watches.

## Graph-frontier execution

The scheduler does not march through milestones one at a time. It works the
entire unblocked frontier of the merged graph — any ticket whose blockers are
all resolved, in any selected project. Cancellation releases downstream work;
a placeholder id nobody has fetched holds its dependents blocked and triggers
its own fetch instruction (§3.1.2 ingest kinds).

Milestone review is a gate, not a phase. Membership is an edge (`ticket →
milestone`), sequencing is an edge (`milestone → milestone`), and a ticket in
a later milestone is *blocked* until every earlier milestone is open: members
resolved, review recorded, and the recorded review still covering exactly the
current member set. A review that files follow-up tickets re-closes the gate
by changing that set. The reviewer's judgment stays in an agent; the gate
arithmetic stays in the CLI.

## Ingest: the graph reaches the CLI through the session

The CLI cannot read an MCP-only tracker, so building the graph is delegated:
`dispatch refresh` opens a scan, the server pushes `scan_project` and
`fetch_ticket` instructions, and the session fetches and writes back through
the flat commands (`project`/`milestone`/`ticket`/`edge`). The CLI decides
what still needs fetching; the session never does. Tracker specifics live in a
`tracker-adapter-<id>` skill, so a new tracker is a new adapter, not a new
orchestrator.

## Human-interactive tickets

Some tickets must be handled by a human — an explicit tracker signal
(`requires-human`, a `human-only` target kind), or a worker-discovered wall
that parked the ticket. The scheduler never dispatches them; it emits one
`park_human_blocked` order per episode, and the session parks the ticket and
posts the handoff through the adapter. The parked ticket holds no slot, and
its dependents unblock when a human moves it.

A worker-discovered wall is a different condition from `requires-human`: the
work is agent-workable, but mid-flight an operator response became the
blocker. A ticket parks and resumes as above. A PR item has no status to
park, so its worker records a `human-blocked` outcome instead; the scheduler
alerts the operator once per episode, and removing the outcome requeues the
item.

## Runtime injection

Ad-hoc work enters through the store mid-run: a ticket written with
`--injected`, or a bare PR / prompt item via `dispatch pr set --injected`.
Both rank to the head of the queue without preempting anything in flight; the
next tick dispatches them.

## Relationship to the other protocols

Orchestration sits on top of everything else. It consumes §2.3 (the status
vocabulary, dependency and milestone rules), launches workers whose ticket and
PR behavior are §2.5 and §2.4, rides the channel of §3.1, and inherits §2.1
for every comment an agent writes. It adds the graph, the scheduler tick, the
compute-slot ledger, the milestone gate, and injection — and nothing about an
individual ticket or PR, which the agents already own.
