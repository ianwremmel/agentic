---
name: design-to-project
description:
    Convert an approved design document into a Linear project with milestones,
    dependency graphs, and detailed implementation tickets. Use when the user
    invokes "/design-to-project <path-to-design-doc>". Reads the design doc,
    analyzes it with staff-engineer, creates tickets with pragmatic-pm, and
    produces a fully populated Linear project ready for /linear-project
    execution.
---

**PLAN MODE GUARD:** If plan mode is active, do NOT proceed. Instead, tell the
user: "The design-to-project skill is an orchestrator that manages subagents. It
cannot operate in plan mode — please exit plan mode and re-invoke
`/design-to-project`." Then stop.

# Design-to-Project Lifecycle

Announce at start: "I'm using the design-to-project skill to convert design
document `<DESIGN_DOC_PATH>` into a Linear project."

Parse the design document path from the skill arguments. All phases below use
these shared variables:

- `DESIGN_DOC_PATH` — absolute path to the design document
- `DESIGN_DOC_CONTENT` — full text of the design document
- `DESIGN_TITLE` — extracted from the H1 heading
- `DESIGN_STATUS` — extracted from the `**Status:**` field
- `PROJECT_NAME` — Linear project name (derived from title, confirmed by user)
- `PROJECT_ID` — Linear project ID (set during Phase 5)
- `TEAM_ID` — Linear team ID (fetched in Phase 1)
- `ANALYSIS_PATH` — `/tmp/claude/design-analysis/<PROJECT_NAME>.json`
- `TICKETS_PATH` — `/tmp/claude/design-tickets/<PROJECT_NAME>.json`

## Phase 1: Validate & Read

1. Parse `DESIGN_DOC_PATH` from skill arguments. If it's a relative path,
   resolve it against the repo root. Read the file using the `Read` tool. If the
   file does not exist, stop and report: "Design document not found at
   `<path>`."

2. Extract from the document:
    - `DESIGN_TITLE` — the first `#` heading
    - `DESIGN_STATUS` — from the `**Status:**` field in the header
    - Identify the four canonical sections: Problem, Solution, Design Details,
      Implementation Steps. If Implementation Steps is missing or empty, stop
      and report: "This design document has no Implementation Steps section.
      This section is required to generate tickets."

3. **Status check**: If `DESIGN_STATUS` is not "Approved", warn the user: "This
   design document has status '<DESIGN_STATUS>'. Proceeding — confirm if you
   want to create tickets for a non-approved design." Wait for confirmation via
   AskUserQuestion before continuing.

4. Fetch Linear teams:

    ```
    ToolSearch(query: "+linear list teams")
    mcp__linear-server__list_teams()
    ```

    If only one team exists, set `TEAM_ID` automatically. If multiple teams, ask
    the user which team via AskUserQuestion.

5. Derive `PROJECT_NAME` from `DESIGN_TITLE` (strip date prefix if present,
   convert to title case). Ask the user to confirm or provide an alternative:
   "I'll create a Linear project named '<PROJECT_NAME>'. Confirm or provide an
   alternative name."

## Phase 2: Staff-Engineer Analysis

Dispatch a `staff-engineer` subagent with:

- The full `DESIGN_DOC_CONTENT`
- The instructions from `references/design-analysis.md`
- Variables: `DESIGN_DOC_PATH`, `DESIGN_TITLE`, `PROJECT_NAME`, `ANALYSIS_PATH`

The subagent explores the codebase, validates affected files/packages, and
writes its analysis to `ANALYSIS_PATH`. Wait for subagent completion, then read
the output JSON.

**Clarification round**: After reading the analysis, check for:

- Steps flagged as vague or underspecified (`needs_clarification: true`)
- Steps flagged as exceeding the 800-line PR budget (`needs_splitting: true`)
- High-severity risks
- Uncertain implicit dependencies

For any of these, present specific questions to the user via AskUserQuestion.
Examples:

- "Step 3 mentions 'split handlers' — the analysis proposes splitting into 3
  sub-tickets (lambda, express, cleanup). Does this breakdown look right?"
- "Step 5 and 7 are marked as coupled. Should they be in the same milestone or
  sequential milestones with a coordination note?"

Do NOT proceed to Phase 3 with unresolved ambiguities. Update the analysis JSON
with the user's answers if needed.

## Phase 3: Pragmatic-PM Ticket Planning

Dispatch a `pragmatic-pm` subagent with:

- The full `DESIGN_DOC_CONTENT`
- The staff-engineer analysis from `ANALYSIS_PATH`
- The instructions from `references/project-creation.md`
- The ticket template from `references/ticket-template.md`
- Variables: `DESIGN_DOC_PATH`, `DESIGN_TITLE`, `PROJECT_NAME`, `TICKETS_PATH`

The subagent produces fully detailed tickets and writes them to `TICKETS_PATH`.
Wait for subagent completion, then read the output JSON.

## Phase 4: User Review & Confirmation

Present the full plan to the user in this format:

```
## Proposed Linear Project: <PROJECT_NAME>

### Milestones
1. <Milestone 1 name> (<N> tickets)
   Gate: <what must be true before next milestone>
2. <Milestone 2 name> (<N> tickets)
   Gate: <what must be true before next milestone>
...

### Dependency Graph
<visual showing ticket dependencies using indentation and arrows>

### Tickets

#### Milestone 1: <name>
| # | Title | Deps | Size | Priority |
|---|-------|------|------|----------|
| T1 | <title> | — | M | P2 |
| T2 | <title> | T1 | S | P2 |

#### Milestone 2: <name>
...

### Risks
- <risk 1>
- <risk 2>

Total: <N> tickets across <M> milestones
```

**Mandatory user confirmation** before creating anything in Linear. If the user
requests changes:

- For minor edits (rename a ticket, adjust priority, change a dependency): apply
  directly to `TICKETS_PATH` data without re-dispatching subagents.
- For major restructuring (reorder milestones, merge/split tickets
  significantly): re-dispatch the pragmatic-pm subagent with updated
  constraints.
- Re-present the updated plan after each round of edits.

## Phase 5: Linear Project Creation

Once the user confirms, create all artifacts in Linear.

### Step 1: Create the project

```
ToolSearch(query: "+linear save project")
mcp__linear-server__save_project(
  name: PROJECT_NAME,
  description: "Implementation of design: <DESIGN_TITLE>\n\nDesign doc: <DESIGN_DOC_PATH>",
  addTeams: [TEAM_ID]
)
```

Store `PROJECT_ID` from the result.

### Step 2: Create milestones (sequentially, to preserve sort order)

For each milestone in order:

```
ToolSearch(query: "+linear save milestone")
mcp__linear-server__save_milestone(
  name: <milestone.name>,
  description: <milestone.description>,
  project: PROJECT_ID,
  sortOrder: <milestone.sort_order>
)
```

Store each milestone ID mapped to its index.

### Step 3: Create tickets (in topological order)

Process milestones in order. Within each milestone, create tickets in dependency
order — a ticket's blockers must already exist. For each ticket:

```
mcp__linear-server__save_issue(
  title: <ticket.title>,
  description: <ticket.description>,
  team: TEAM_ID,
  project: PROJECT_ID,
  milestone: <milestone_id>,
  priority: <ticket.priority>,
  labels: <ticket.labels>,
  blockedBy: [<identifiers of previously created blocking tickets>]
)
```

Store the created issue identifier in a map from ticket index to identifier.

**Retry logic**: If any MCP call fails, retry up to 3 times with 5-second
delays. If still failing after retries, report what was created so far and what
remains. Do NOT roll back successfully created artifacts.

### Step 4: Link design document

Update the project description to include a link to the design document. If the
repo is on GitHub, construct the URL:

```
https://github.com/<REPO_OWNER>/<REPO_NAME>/blob/main/<DESIGN_DOC_PATH>
```

## Phase 6: Report Results

Present the final summary to the user:

```
## Project Created: <PROJECT_NAME>

### Milestones
| # | Name | Tickets |
|---|------|---------|
| 1 | <name> | <count> |
| 2 | <name> | <count> |

### All Tickets
| Identifier | Title | Milestone | Blocked By |
|------------|-------|-----------|------------|
| CLC-42 | <title> | <milestone> | — |
| CLC-43 | <title> | <milestone> | CLC-42 |

### Next Steps
Run `/linear-project <PROJECT_NAME>` to begin implementation.
```

## Error Handling

| Scenario                        | Action                                             |
| ------------------------------- | -------------------------------------------------- |
| Design doc not found            | Stop, report path                                  |
| Missing Implementation Steps    | Stop, explain requirement                          |
| Non-approved status             | Warn, ask user, continue if confirmed              |
| Multiple Linear teams           | Ask user to choose                                 |
| Staff-engineer subagent fails   | Report partial analysis, ask user how to proceed   |
| PM subagent fails               | Show staff-engineer analysis, offer manual proceed |
| User rejects plan               | Accept edits, re-present                           |
| Ticket creation partially fails | Report created vs remaining, offer retry           |
| No clear phases in design doc   | Staff-engineer proposes milestone boundaries       |
| Step exceeds 800 lines          | Split into sub-tickets, present to user            |
| Vague implementation steps      | Staff-engineer expands, asks user questions        |
| Linear MCP tools unavailable    | Load via ToolSearch, retry 3x, then stop           |
