# §2.6.1 — Orchestration Protocol: Narrative

## Why orchestration

Driving a whole project — or several at once — means working many tickets that
sit in a dependency graph: some ready, some blocked, some needing a human, some
gated behind a milestone review. The work spans hours or days and dozens of
tickets. Holding all of that in one agent's context exhausts it long before the
project finishes.

The Orchestration Protocol defines a **thin, graph-driven dispatcher** that
solves this by owning almost nothing. It owns the *graph* and the *bookkeeping*:
which tickets are unblocked, which have a live owner, which slot is free, whether
a milestone is ready for review. It does not read ticket bodies, evaluate CI or
reviews, or run milestone reviews. Each of those belongs to a lower tier, and the
orchestrator sheds its context every tick so a multi-day run never accumulates
state in memory.

## Three tiers

The protocol composes three scopes, each bounded differently:

| Tier             | Scope                   | Bound         | Loop style          |
| ---------------- | ----------------------- | ------------- | ------------------- |
| **orchestrator** | the whole project graph | unbounded     | stateless ticks     |
| **coordinator**  | one work item (§2.5)    | one work item | dispatched subagent |
| **worker**       | one PR (§2.4 Delivery)  | one PR        | in-turn             |

A worker can stay live in a single turn because its scope — one PR — is bounded.
A coordinator owns one work item, which may fan out to several PRs, so it brokers
between the orchestrator and a sequence of workers. The orchestrator spans an
unbounded graph, so it cannot stay in one turn; it runs as a series of
**stateless ticks**, each a fresh context that reads state from disk and the
tracker, acts, and exits. This is the load-bearing reason the orchestrator uses a
tick loop while the worker does not.

One more agent kind sits beside the coordinator: a **milestone review agent**,
dispatched when a milestone is ready for review (below). Everything else the
orchestrator might have special-cased — a no-PR *verification* ticket, or an
injected bare PR — is **also** handled by a coordinator, which just branches on
the work's kind. So the orchestrator dispatches only **coordinators and milestone
review agents** and stays a clean graph→coordinator dispatcher, with no per-kind
special cases of its own.

## Graph-frontier execution

The orchestrator does not march through milestones one at a time. It reads one
**merged dependency graph** spanning every selected project and continuously
works the entire unblocked frontier — any ticket whose blockers are all resolved,
regardless of which project or milestone it belongs to. Cross-project dependencies
within a single tracker are honored; cross-tracker dependencies remain out of
scope (§2.3).

Milestone review is **not** a phase the orchestrator stops to run. When a
milestone becomes ready for review (§2.3), the orchestrator dispatches a separate
**milestone review agent** as an asynchronous gate. The gate's effect on
scheduling is expressed entirely through the graph: a ticket gated on a prior
milestone is reported *blocked* until that milestone is both ready-for-review and
review-recorded, so the orchestrator honors it through ordinary blocked-frontier
logic with no special-case milestone state machine. The milestone review agent may
file follow-up tickets in the current milestone, which re-block advancement —
again, visible to the orchestrator only as the frontier changing shape.

Milestone review often needs human judgment. The milestone review agent gathers it
through
the milestone-review artifact's comments (§2.3 routing) — a Linear project update,
a GitHub Milestone comment, an Asana milestone-task comment — not the session, so
the decision stays auditable in the tracker; it doesn't record the review outcome
until that input resolves. (A team that prefers a human to *own* the review can
model the review item as `human-interactive` instead.)

## The normalized project-graph document

Every tracker disagrees about state, dependencies, and milestones. Rather than
teach the orchestrator each tracker's API, the protocol defines one
**tracker-neutral project-graph document**: the merged graph, every ticket node
tagged with its §2.3 role, its milestone, its blocked status, and a small set of
*derived* sections the orchestrator reads directly — the ranked available
frontier, the blocked set, the human-blocked set, the permanently-blocked set,
milestone ready/reviewed flags, counts, and anomalies (cycles, cross-project
reverse edges).

The orchestrator consumes only those derived summaries and node tags. It never
parses a raw ticket body — that is the coordinator's job. This is what keeps the
orchestrator thin: all graph *reasoning* (effective-blocking per §2.3, ranking,
cycle detection) happens before the document reaches it.

## Producers and adapters

A **producer** emits the project-graph document. Producers are swappable behind
one fixed contract, so support for a new tracker is a new adapter, not a change to
the orchestrator. A producer for a tracker with an API and a token can be a CLI or
a library call; a tracker reachable only through MCP can be served by an
MCP-driven fetch subagent that emits the same document. The orchestrator invokes
the producer identically either way.

Two properties matter:

- **Access style is orthogonal to credential mode.** Whether the producer reaches
  the tracker by API, CLI, or MCP is an adapter detail. It has nothing to do with
  §2.1's Mode A / Mode B, which is about *whose identity acts* and *how human
  input is routed* — credential ownership, not access mechanism. Any mode can be
  served by any access style.
- **Fetches are incremental.** Rebuilding the whole graph every tick is wasteful.
  The orchestrator keeps a durable normalized graph on disk plus an opaque
  per-source **sync cursor**, and each tick asks the producer only for what
  *changed since* that cursor. A full sync is the fallback — first run, recovery,
  or a cursor gap — not the steady state.

## Human-interactive tickets

Some tickets must be handled by a human. The orchestrator learns this two ways,
and both converge on the same resting state:

- **Explicit signal** — the graph node carries a `human-interactive` flag,
  derived from a configured tracker signal (a label or field), consistent with
  §2.3's metadata-driven role overrides. The orchestrator sees it before
  dispatching anything and never sends a coordinator.
- **Worker-discovered** — a coordinator (§2.5) hits a wall mid-flight, parks the
  ticket in `awaiting-external`, and alerts a human. The orchestrator simply
  observes the parked role on the next fetch.

Either way, the orchestrator's rule is the same: never dispatch a coordinator for
it, make sure exactly one outstanding human alert exists, and re-check it each
tick. A parked ticket holds no slot — it isn't computing. Its dependents stay
blocked until the human finishes — a role change the next fetch picks up,
unblocking the frontier.

Note that "needs a human" is **not** a new §2.3 role; it reuses
`awaiting-external` plus a tracker-signal-derived flag on the graph node.

## Runtime injection

The orchestrator accepts ad-hoc work mid-run through an injection inbox:

- An injected **ticket** is just another graph node. The producer pulls in its
  transitive dependency ancestors and ranks it; it lands at the *top* of the
  available frontier but does **not** preempt in-flight work — it is dispatched at
  the next tick that has free compute capacity.
- An injected **PR** is worked by a coordinator scoped to that PR (not a bare
  worker), landing at the top of the queue ahead of a lower-ranked ticket, again
  without preempting work in flight.

## Relationship to the other protocols

Orchestration sits on top of everything else. It consumes §2.3 (the role
vocabulary, dependency and milestone rules, the operational log), dispatches §2.5
coordinators (which internally drive §2.4 delivery workers) and milestone review
agents, and inherits §2.1 for every comment it writes. It adds the graph, the tick
loop, the producer/cursor contract, the compute-slot ledger, the milestone-review
gate, and runtime injection — and nothing about an individual ticket or PR, which
the tiers below it already own.
