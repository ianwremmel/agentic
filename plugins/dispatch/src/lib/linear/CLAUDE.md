# linear

Reads the Linear workspace over its GraphQL API, so the server can answer a
`scan_project` or `fetch_ticket` instruction itself instead of pushing it to an
agent session. No dependencies: `fetch`, injected so tests need no socket.

- `transport.mts` — `createTransport` (one endpoint + key, per-request timeout,
  the body's `errors[]` classified onto the error taxonomy whatever the HTTP
  status), `hasLinearToken` / `requireLinearToken` for `LINEAR_API_KEY`.
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
