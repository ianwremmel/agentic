# Design Analysis: Staff-Engineer Subagent Protocol

Dispatched as a `staff-engineer` subagent by the orchestrator. Reads the design
document and explores the codebase to produce a structured analysis of
milestones, dependencies, PR scoping, and risks. The orchestrator reads only the
output JSON — never the subagent's full transcript.

## Input Variables

The orchestrator provides these in the dispatch brief:

- `DESIGN_DOC_PATH` — absolute path to the design document
- `DESIGN_TITLE` — the design document title
- `PROJECT_NAME` — the proposed Linear project name
- `ANALYSIS_PATH` — where to write the output JSON

The orchestrator also provides the full design document content inline in the
dispatch brief.

## Output

- **Primary file**: The path specified by `ANALYSIS_PATH` (typically
  `/tmp/claude/design-analysis/<PROJECT_NAME>.json`)

The subagent MUST write the output JSON file as its FINAL action. The
orchestrator waits for completion then reads only this file.

## Steps

### 1. Parse the Implementation Steps

Read the "Implementation Steps" section of the design document. Identify:

- Numbered or named steps/phases
- Explicit ordering constraints (e.g., "Steps 1-2 are prerequisites")
- Parallelization notes (e.g., "Steps 3 and 4 can be parallelized")
- Coupling statements (e.g., "Step 5 and 7 are coupled")
- PR budget warnings (e.g., "this step will likely need to be broken into
  sub-PRs")
- Steps that reference needing their own design document (these should be
  included as tickets but flagged)

### 2. Explore the Codebase

For each implementation step, explore the actual codebase to validate and enrich
the analysis. Use `Grep`, `Glob`, and `Read` tools (NOT grep, find, or cat
commands).

For each step:

a. **Validate affected files**: Check that files/packages mentioned in the
design doc actually exist. Note any that don't (they may need to be created).

b. **Assess scope**: Read the affected files to estimate how many lines of code
will change. Consider:

- Lines to add (new packages, new files)
- Lines to modify (refactoring existing code)
- Lines to delete (cleanup)
- Test code needed (colocated `<file>.test.mts` files)
- Generated code changes (files in `__generated__/` — these don't count toward
  the PR budget but must be committed)

c. **Identify implicit dependencies**: Search for imports and type references
across the affected files. If step A modifies a type that step B's files import,
that's an implicit dependency even if the design doc doesn't mention it.

d. **Find existing patterns**: Look for similar existing code that the
implementor should follow. Note file paths.

### 3. Build the Dependency Graph

Construct a dependency graph from:

a. **Explicit dependencies**: Stated in the design doc text (e.g., "depends on
step X", "requires step Y to be complete")

b. **Implicit dependencies** discovered during codebase exploration:

- Shared type definitions that must be created before consumers
- API contracts that must exist before implementations
- Package creation that must precede code that imports from it
- Generated code templates that must be updated before code that uses the
  generated output

c. **Coupling**: Steps that modify the same files or the same API surface and
must be coordinated. These don't necessarily need to be sequential — they may
just need to be in the same milestone or done in immediate sequence.

### 4. Propose Milestone Boundaries

Group steps into milestones. Each milestone must:

- Produce a working system (all tests pass, no broken imports)
- Have a clear gate (what must be true before proceeding)
- Contain steps that can be parallelized internally where possible
- Not have backward dependencies to later milestones

Guidelines for grouping:

- Prerequisites (package creation, type extraction) → first milestone
- Core implementation steps → middle milestones
- Cleanup and migration → final milestone
- Documentation updates belong in the ticket that changes behavior — not as
  separate documentation tickets or a deferred milestone item
- Coupled steps should be in the same milestone
- If a step needs its own design document, put it in a later milestone or flag
  it as out of scope

**Minimum ticket count per milestone**: Each milestone MUST contain at least 4
tickets. `/linear-project` processes milestones sequentially with
`MAX_PARALLEL_ISSUES = 3`, so milestones with fewer than 4 tickets create
artificial bottlenecks — the orchestrator is stuck at the milestone boundary
waiting for the last 1-2 issues to finish while parallelism capacity goes
unused. If a proposed milestone has fewer than 4 tickets, merge it with an
adjacent milestone (prefer merging forward into the next milestone; merge
backward into the previous one if merging forward would make the next milestone
exceed about 10 tickets). The only exception is the final milestone, which may
have fewer than 4 tickets if it contains only cleanup or migration work that
genuinely cannot be combined with earlier milestones.

### 5. Assess PR Scoping

For each step, determine if it fits within the 500-800 line PR budget:

- **S (Small)**: < 200 lines. Fits easily.
- **M (Medium)**: 200-500 lines. Fits.
- **L (Large)**: 500-800 lines. At the limit — flag for awareness.
- **XL (Needs splitting)**: > 800 lines. Must be split into sub-tickets.

For XL steps, propose concrete splits:

- Each split should be independently shippable
- Splits should follow natural boundaries (one package at a time, separate
  creation from migration, etc.)
- Each split should fit within the PR budget

### 6. Identify Risks

Assess each step for:

- **Coordination risk**: Steps that touch generated code (changes ripple to all
  consumers), steps that modify shared types, steps that change API contracts
- **Unknown scope**: Steps where the design is vague about what exactly changes
- **External dependencies**: Steps that depend on work outside this design doc
- **Ordering sensitivity**: Steps where the wrong order would cause cascading
  rework

### 7. Flag Vague Steps

For any step where:

- The design doc doesn't specify which files/packages are affected
- The scope is unclear ("refactor X" without specifying what changes)
- The end state is ambiguous

Set `needs_clarification: true` and provide a `clarification_question` field
explaining what the orchestrator should ask the user.

### 8. Write Output JSON

Ensure the output directory exists:

```bash
mkdir -p /tmp/claude/design-analysis
```

Write the JSON to `ANALYSIS_PATH` using the Write tool.

## Output JSON Schema

```json
{
    "design_title": "str",
    "design_doc_path": "str",
    "analyzed_at": "ISO-8601 timestamp",

    "milestones": [
        {
            "name": "M1: Foundation",
            "description": "Establish package structure and extract interfaces",
            "steps": [1, 2],
            "gate": "All interface types are defined in @clc/abstractions and importable by downstream packages. All tests pass.",
            "sort_order": 0
        }
    ],

    "tickets": [
        {
            "step_ref": "1",
            "title": "chore(framework): establish packages/framework/ category",
            "scope_estimate": "S",
            "needs_splitting": false,
            "proposed_splits": [],
            "needs_clarification": false,
            "clarification_question": null,
            "dependencies": [],
            "implicit_dependencies": [
                {
                    "ref": "2",
                    "reason": "@clc/abstractions will live in packages/framework/, so the category must exist first"
                }
            ],
            "parallelizable_with": [],
            "risks": [],
            "affected_packages": ["@clc/nx"],
            "affected_files_hint": [
                "tsconfig.base.json",
                "packages/tooling/@clc/nx/src/create-nodes.mts"
            ],
            "milestone_index": 0,
            "needs_own_design": false
        }
    ],

    "risks": [
        {
            "severity": "high",
            "description": "Steps 5 and 7 modify the dispatch() API and codegen templates simultaneously — mis-ordering causes build failures",
            "mitigation": "Place in the same milestone and coordinate merge order"
        }
    ]
}
```

### Field Reference

- `step_ref` — reference to the implementation step number/label from the design
  doc. May be "1", "2a", "3.1", etc., matching whatever notation the design doc
  uses.
- `scope_estimate` — "S", "M", "L", or "XL". XL means needs splitting.
- `proposed_splits` — array of objects with
  `{title, scope_estimate, description}` for each proposed sub-ticket. Only
  populated when `needs_splitting: true`.
- `needs_clarification` — true if the step is too vague to create a useful
  ticket without user input.
- `clarification_question` — specific question to ask the user about this step.
- `dependencies` — explicit dependencies (step_refs that must complete first),
  sourced from the design doc text.
- `implicit_dependencies` — dependencies discovered through codebase
  exploration. Each entry includes a reason so the orchestrator can present them
  to the user.
- `parallelizable_with` — step_refs that can execute concurrently with this step
  (no shared file conflicts, no dependency relationship).
- `milestone_index` — which proposed milestone this ticket belongs to.
- `needs_own_design` — true if the design doc indicates this step warrants its
  own separate design document.

## Notes

- Use `Grep` tool (not grep/rg commands), `Read` tool (not cat/head/tail),
  `Glob` tool (not find) for all file operations.
- Do NOT edit any files. This is a read-only analysis.
- Do NOT edit any `package.json` files.
- The Linear MCP tools are NOT needed for this subagent — it analyzes the design
  doc and codebase only.
- The subagent must write the output JSON file as its FINAL action.
- When exploring the codebase, be thorough but focused. Read the specific files
  referenced in the design doc. Don't explore the entire repository.
