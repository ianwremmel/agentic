# Project Creation: Pragmatic-PM Subagent Protocol

Dispatched as a `pragmatic-pm` subagent by the orchestrator. Receives the design
document and staff-engineer analysis, then produces fully detailed tickets ready
for creation in Linear. The orchestrator reads only the output JSON — never the
subagent's full transcript.

## Input Variables

The orchestrator provides these in the dispatch brief:

- `DESIGN_DOC_PATH` — absolute path to the design document
- `DESIGN_TITLE` — the design document title
- `PROJECT_NAME` — the confirmed Linear project name
- `TICKETS_PATH` — where to write the output JSON

The orchestrator also provides inline:

- The full design document content
- The staff-engineer analysis JSON (from `ANALYSIS_PATH`)
- The ticket template (from `references/ticket-template.md`)

## Output

- **Primary file**: The path specified by `TICKETS_PATH` (typically
  `/tmp/claude/design-tickets/<PROJECT_NAME>.json`)

The subagent MUST write the output JSON file as its FINAL action. The
orchestrator waits for completion then reads only this file.

## Steps

### 1. Internalize the Analysis

Read the staff-engineer analysis carefully. Extract:

- Proposed milestones with gates
- Ticket list with dependencies, scope estimates, and splits
- Risks and coordination requirements
- Any clarification answers the orchestrator has annotated

### 2. Refine Milestones

Accept the staff-engineer's milestone structure as the starting point. Adjust
only if:

- A milestone has too many tickets (> 8-10) — consider splitting
- A milestone has fewer than 4 tickets — merge with an adjacent milestone
  `/linear-project` processes milestones sequentially with
  `MAX_PARALLEL_ISSUES = 3`, so small milestones create artificial bottlenecks
  where parallelism capacity goes unused while waiting for the last issues to
  complete. Prefer merging forward; merge backward only if merging forward would
  cause the next milestone to exceed the "too many tickets" threshold above
  (i.e., go beyond ~8-10 tickets). The only exception is the final milestone
  (cleanup/migration)
- Gate criteria are vague — make them specific and testable
- A milestone mixes unrelated concerns — separate for clearer review gates

Each milestone must have:

- A clear, descriptive name (e.g., "M1: Foundation & Interfaces" not just "Phase
  1")
- A description explaining what this milestone accomplishes
- A `sort_order` starting from 0

### 3. Expand Tickets with Splits

For each ticket in the staff-engineer analysis:

- If `needs_splitting: true`, create separate tickets from `proposed_splits`
- If `needs_own_design: true`, create a single ticket that says "Write design
  document for <topic>" — don't try to decompose it further
- Preserve the dependency relationships from the analysis

### 4. Write Full Ticket Descriptions

For each ticket, write a complete description following the ticket template from
`references/ticket-template.md`. When writing tickets:

**Context section**: Reference the specific design document section. Explain the
"why" in terms of the overall problem being solved, not just "the design says to
do this."

**Objective section**: Be specific about the end state. "Extract lambda-specific
handlers into `@clc/handlers-lambda`" is better than "Separate concerns in
handlers."

**Acceptance Criteria**: Every criterion must be independently verifiable.
Include:

- At least one functional criterion (the thing works)
- The standard build criterion (`npm run build` passes)
- If creating a new package: README.md and CLAUDE.md exist
- If modifying types: downstream packages compile without errors

**Technical Approach**: Provide starting points and patterns, not step-by-step
instructions. The implementor will explore the codebase and adapt. Include:

- Which files to read first to understand the current state
- Existing patterns to follow (with file paths)
- Known pitfalls specific to this area of the codebase
- What NOT to do (repo-specific constraints)

**Dependencies section**: Use the ticket indices from the analysis. These will
be converted to Linear issue identifiers during creation. Explain WHY each
dependency exists.

**PR Budget**: Use the scope estimate from the analysis. Remind about the
500-800 line hard limit. Include the deferral instruction.

**Verification**: Include specific test commands. For package changes:
`npm run build`. For test changes: reference the specific test file.

### 5. Assign Priorities

Use Linear priority values (1 = Urgent, 2 = High, 3 = Medium, 4 = Low):

- **P1 (Urgent)**: Prerequisites that block everything else. Foundation work in
  milestone 1.
- **P2 (High)**: Core implementation steps. Most tickets will be P2.
- **P3 (Medium)**: Independent work that can be deferred without blocking
  others.
- **P4 (Low)**: Cleanup, nice-to-have improvements, future considerations.

Within a milestone, higher priority tickets should generally be scheduled first
(though dependency ordering takes precedence).

### 6. Assign Labels

Assign labels based on the type of work:

- `refactor` — restructuring existing code without changing behavior
- `feature` — new functionality
- `chore` — infrastructure, tooling, configuration
- `docs` — documentation-only changes
- `test` — test-only changes

Also add labels for affected areas when useful (e.g., `codegen`, `framework`,
`parser`). Keep the label set small and consistent.

### 7. Validate the Ticket Set

Before writing the output, verify:

- Every ticket is independently deliverable (no hidden prerequisites)
- Every dependency is accounted for (no ticket references a nonexistent blocker)
- No circular dependencies exist within a milestone
- Every ticket fits within the PR budget (no XL without splits)
- Milestones are sequential — no ticket in milestone N depends on a ticket in
  milestone N+1
- The first milestone has at least one ticket with no dependencies (the entry
  point)
- Total ticket count is reasonable (typically 5-25 for a design doc)

### 8. Write Output JSON

Ensure the output directory exists:

```bash
mkdir -p /tmp/claude/design-tickets
```

Write the JSON to `TICKETS_PATH` using the Write tool.

## Output JSON Schema

```json
{
    "project_name": "str",
    "design_doc_path": "str",
    "created_at": "ISO-8601 timestamp",

    "milestones": [
        {
            "name": "M1: Foundation & Interfaces",
            "description": "Establish the packages/framework/ category and extract all interface types into @clc/abstractions. After this milestone, all downstream packages can import abstract types without pulling in concrete implementations.",
            "sort_order": 0,
            "gate": "All interface types are importable from @clc/abstractions. All existing tests pass. No package depends on a concrete implementation solely for type imports.",
            "ticket_count": 2
        }
    ],

    "tickets": [
        {
            "title": "chore(nx): establish packages/framework/ category",
            "description": "## Context\n\nThe design for splitting abstractions from concretions...",
            "milestone_index": 0,
            "blocked_by_indices": [],
            "priority": 1,
            "labels": ["chore"],
            "complexity": "S"
        },
        {
            "title": "refactor(abstractions): extract interface types into @clc/abstractions",
            "description": "## Context\n\n...",
            "milestone_index": 0,
            "blocked_by_indices": [0],
            "priority": 1,
            "labels": ["refactor", "framework"],
            "complexity": "M"
        }
    ],

    "summary": {
        "total_tickets": 12,
        "total_milestones": 4,
        "estimated_complexity": {
            "S": 3,
            "M": 6,
            "L": 3
        }
    }
}
```

### Field Reference

- `milestone_index` — zero-based index into the `milestones` array
- `blocked_by_indices` — zero-based indices into the `tickets` array (NOT the
  milestones array). These are converted to Linear issue identifiers by the
  orchestrator during creation.
- `priority` — Linear priority value (1-4)
- `complexity` — "S", "M", or "L" (XL tickets should have been split)
- `description` — full markdown following the ticket template. Must be
  self-contained — an implementor reading only this ticket should have enough
  context to start working.

## Notes

- Use `Grep` tool (not grep/rg commands), `Read` tool (not cat/head/tail),
  `Glob` tool (not find) for any file operations.
- Do NOT edit any files other than the output JSON. This is a planning exercise.
- Do NOT edit any `package.json` files.
- Linear MCP tools are NOT needed — the orchestrator handles all Linear
  operations.
- The subagent must write the output JSON file as its FINAL action.
- When writing ticket descriptions, include the repo-specific rules from the
  ticket template (no package.json edits, api.yml for routes, colocated tests,
  etc.). These rules are critical for AI agent implementors.
