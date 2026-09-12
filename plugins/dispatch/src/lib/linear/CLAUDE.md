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

The SDK's generated operations are not used, only its GraphQL client. Its
models fetch relations lazily — `issue.state`, `issue.labels()`,
`issue.relations()` and `issue.inverseRelations()` are four more round trips
per issue — so a scan of a few hundred issues would be a few thousand requests
against an API that rate-limits on complexity. The documents here ask for all
of it in one page, which is the whole reason to hold a GraphQL client rather
than drive the MCP tools.

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

The module is Linear's vocabulary, not dispatch's: it returns workflow-state
names and Linear priorities. Mapping those onto dispatch statuses belongs to
the caller, next to the rest of the tracker binding.
