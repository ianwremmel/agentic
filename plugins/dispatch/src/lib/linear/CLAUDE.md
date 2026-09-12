# linear

Reads the Linear workspace over its GraphQL API, so the server can answer a
`scan_project` or `fetch_ticket` instruction itself instead of pushing it to an
agent session. `@linear/sdk` is the GraphQL client.

- `transport.mts` — `createTransport` (one endpoint + key, per-request timeout,
  a rejection classified onto the dispatch error taxonomy), `credentials` for
  which SDK slot the token goes in, and `hasLinearToken` / `requireLinearToken`
  for `LINEAR_API_KEY`.
- `queries.mts` — the query documents, and `NESTED_PAGE_SIZE`.
- `client.mts` — `LinearClient`: `listProjects`, `listMilestones`,
  `listIssues` (delta-filtered, inclusive, on `updatedAt`),
  `listIssueIdentifiers` (membership, for spotting a ticket that left), and
  `getIssue` (by identifier, `null` when absent). Every list walks its
  connection to the end, up to a thousand pages; every read takes a `signal`,
  because the transport's timeout bounds one request and a walk is many.
- `types.mts` — what the client returns, plus the `Page` shape paging is
  written against.
- `live.test.mts` — runs the real query documents against Linear. Skipped
  unless `DISPATCH_LIVE_TESTS=1` and `LINEAR_API_KEY` are both set, because it
  is the only thing that catches a field the schema no longer has.

The SDK's generated operations are not used, only its GraphQL client and its
generated input types. `LinearDocument.IssuesDocument` selects the generated
`Issue` fragment: 63 selections, most of which this module never reads, and it
still carries no `labels`, `relations` or `inverseRelations`, and `state { id }`
rather than the state's name — so the nested reads are separate documents
(`Issue_LabelsDocument` and friends), three or more extra round trips per
issue, against an API that rate-limits on complexity. Its lazy models
(`issue.labels()`, `issue.state`) are the same round trips by another route.
The documents here ask for all of it in one page, which is the whole reason to
hold a GraphQL client rather than drive the MCP tools.

Filter variables are typed `LinearDocument.IssueFilter` and
`LinearDocument.ProjectFilter`. That catches an unknown filter field or a
comparator given the wrong kind of value at `tsc`, and it catches Linear
renaming or retyping one of them on the next SDK bump — which is the drift
that otherwise lands as a runtime rejection. It says nothing about the query
documents, which only `live.test.mts` checks, and nothing about whether a
filter means what the caller intended: every field is optional, so an empty
filter typechecks.

The delta cursor goes over the wire as the string it was stored as.
`DateComparator` takes `DateTimeOrDuration`, which is wider than an ISO
timestamp — `2021` is that midnight, `-P2W1D` a date two weeks and a day ago —
and parsing it to a `Date` first would refuse those, drop sub-millisecond
precision, and roll a date that does not exist over into one that does.

Two things the SDK does not decide for itself are decided here. A rejection is
classified by `extensions.code` where Linear sent one — the SDK reads only the
sibling `extensions.type`, which is prose — and by weighing every error in the
response rather than the first, which is all the SDK types itself from. Only
`GRAPHQL_VALIDATION_FAILED` takes the terminal "fix the query" route; a bare
`graphql error` is retried, because Linear puts that label on anything raised
in the GraphQL layer.

An install pulls `graphql` as well, ~12MB that never loads: it is a peer of a
type-only dependency of the SDK, which vendors its own copy of the one function
it needs. Generating the shrinkwrap with `--legacy-peer-deps` drops it from the
lock and then `npm ci` refuses the lock, so the weight stays.

Two rules the queries encode, both learned from the tracker adapter:
archived issues are selected everywhere (Linear hides completed work by
default, and an archived ticket still counts toward its milestone), and issues
are paged in `createdAt` order, never `updatedAt`, so a row edited mid-scan
cannot move between pages and be missed. `queries.test.mts` asserts both
against the documents themselves — a mocked executor answers a fixture
whatever the document asked for, so nothing else here would notice a dropped
selection.

A partial answer is refused rather than passed on. A connection that arrives
without its `pageInfo`, a blocking relation with only one end named, a project
Linear does not have: each would otherwise reach the graph as a short list the
caller has no way to doubt, and a ticket with half its blockers schedules
exactly like one with none. An issue whose labels or relations overflow the
inline page is finished with a follow-up request keyed on its UUID, so only
that issue pays for it.

The same refusal covers every field whose default would be a wrong answer
rather than a blank one: the ids and identifiers nothing would match, a
milestone's `sortOrder` (0 sorts it first), an issue's workflow state, its
`priority` (0 is Linear's "No priority", not "unknown"), its `updatedAt` (the
delta cursor, and the input to the SQL deciding whether a review went stale),
a relation's `type` (dropped, every relation filters out and the issue looks
unblocked), and a label's name. An issue's `project` and `projectMilestone`
are refused only when the object came back without its id: `null` there is
Linear saying the issue is in neither, while `{}` is a dropped selection that
would quietly shrink the milestone whose gate is computed over whoever is left.

`title`, `url` and `branchName` still default to `''`, because a blank one is
visibly blank to whoever reads it. A display *name* is refused only when
absent, never when blank — an oddly named row is still a real row, and one
malformed row fails the whole list, so the line is drawn at values something
is matched on.

The module is Linear's vocabulary, not dispatch's: it returns workflow-state
names and Linear priorities. Mapping those onto dispatch statuses belongs to
the caller, next to the rest of the tracker binding.
