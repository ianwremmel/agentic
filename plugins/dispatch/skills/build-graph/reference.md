# build-graph — reference

Lookup tables for [`SKILL.md`](./SKILL.md), bundled so the skill is
self-contained. The spec is authoritative where they differ: §2.2 (XML house
style), §2.3 (roles, dependencies, milestones), §2.6 (producer contract).

## Roles

- **build-graph** — this skill; the §2.6 producer. Fetches, maps, merges, reasons,
  and emits the project-graph document. Does no dispatch and drives no PR.
- **orchestrator** — [`work-project`](../work-project/SKILL.md); the dispatched
  caller. Reads the document's derived sections and node tags; never re-derives.
- **role mapping** — the Linear substate→§2.3-role table in
  [`work-ticket/reference.md`](../work-ticket/reference.md); the single source of
  truth, reused here.

## Project-graph document

XML, mirroring §2.2's `pr-status` house style. The orchestrator reads the derived
sections (the child lists) and node tags, and treats them as authoritative — it
MUST NOT re-derive blocking, ranking, or cycles.

```xml
<project-graph tracker="linear" cursor="2026-07-09T20:59:12Z" all-terminal="false">
  <projects>
    <project id="A" name="Alpha"/>
    <project id="B" name="Beta"/>
  </projects>

  <milestones>
    <!-- ready-for-review / review-recorded are the guarded values (§stale-review) -->
    <milestone id="A-m1" project="A" order="0"
               ready-for-review="false" review-recorded="false" complete="false"/>
    <milestone id="A-m2" project="A" order="1"
               ready-for-review="false" review-recorded="false" complete="false"/>
  </milestones>

  <!-- ranked frontier: dispatch order, top-to-bottom -->
  <available>
    <node id="A-2" url="…" project="A" milestone="A-m1"
          role="available" target-kind="pr" branch-seed="feat/a-2"/>
  </available>

  <blocked>
    <node id="A-3" url="…" project="A" milestone="A-m1" role="available"
          blocked-by="A-2"/>
    <node id="A-4" url="…" project="A" milestone="A-m2" role="available"
          blocked-by="milestone:A-m1"/>   <!-- milestone-gated -->
  </blocked>

  <human-blocked>
    <node id="A-6" url="…" project="A" role="awaiting-external"
          human-interactive="true"/>
  </human-blocked>

  <permanently-blocked>
    <node id="A-5" url="…" project="A" role="available" blocked-by="X-dead"/>
  </permanently-blocked>

  <anomalies>
    <cycle nodes="C1,C2,C3"/>                          <!-- illegal (§2.3) -->
    <cross-project-edge from="A-2" to="B-1"
                        from-project="A" to-project="B"/>
  </anomalies>

  <counts all-terminal="false">
    <project id="A" total="9" verified="1" canceled="1"
             permanently-blocked="2" remaining="5"/>
  </counts>
</project-graph>
```

Node attributes: `id`, `url`, `project`, `milestone` (or omitted), `role` (§2.3),
`target-kind` (`pr` | `verification` | `human-only`), `human-interactive`,
`blocked-by` (comma-separated predecessor ids, or `milestone:<id>` for a gate),
`branch-seed` (non-authoritative hint). A ticket appears in exactly one scheduling
section (`available` / `blocked` / `human-blocked` / `permanently-blocked`) or in
none when it is already terminal (`verified`/`canceled`).

## Reasoning rules

The normative rules build-graph applies before emitting (so no one downstream
repeats them):

| rule                       | detail                                                                                                           |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| dependency-blocking (§2.3) | blocked iff any direct predecessor is not `verified`/`canceled`.                                                 |
| cancellation unblocks      | a `canceled` predecessor is resolved: it never blocks and never causes a permanent block.                        |
| milestone gate (§2.3)      | blocked while any earlier milestone (lower `order`, same project) is not gate-open.                              |
| stale-review guard (§2.6)  | incomplete ⇒ not `ready-for-review`; not-ready ⇒ not `review-recorded`. Gate-open = complete ∧ ready ∧ recorded. |
| permanent-block            | itself dead (non-`verified`, non-`canceled` terminal that won't progress) or transitively behind such a node.    |
| ranking                    | `available` by earliest milestone, then transitive unblocking leverage, then id; injected `top` ids first.       |
| exclusion (§2.6)           | `exclude`d ids omitted from `available` only; still present in the graph with current state.                     |
| anomalies                  | `cycle` (illegal — surface, never work around) and `cross-project-edge` (informational).                         |
| completion                 | project terminal when every ticket is `verified`/`canceled`/permanently-blocked → `all-terminal`.                |

## Tracker operations (Linear)

Reads follow §2.1 mode rules; MCP access is orthogonal to the §2.1 mode.

| need                        | Linear MCP                                                                             |
| --------------------------- | -------------------------------------------------------------------------------------- |
| project tickets + relations | `list_issues(project)` / `get_issue(id, includeRelations=true)` → `blockedBy`/`blocks` |
| substate → role             | `get_issue(id).state` + `list_issue_statuses(team)`; map via work-ticket reference     |
| milestones + order          | the project's milestones and their sequence + review signals                           |
| human-interactive           | the configured `human_interactive_label` on the ticket                                 |

## On-disk paths

The orchestrator owns the base and passes concrete paths; build-graph writes only
what it is told. Conventional layout under the run directory
(`${DISPATCH_CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/dispatch}/work-project/<run-key>/`):

| file        | holds                                                            |
| ----------- | ---------------------------------------------------------------- |
| `graph.xml` | the project-graph document the orchestrator reads (+ its cursor) |

## Later

The document is the stable contract. A per-tracker fetch/normalize **adapter**
(scriptable for API trackers, MCP-driven for others) and a deterministic
**reasoning engine** over a normalized graph are future determinism/speed work,
added without changing this document or the orchestrator. See
[`SKILL.md`](./SKILL.md#later-determinism--per-tracker-adapters).
