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
  `getIssue` (by identifier, `null` when absent). Every list pages to
  completion.
- `types.mts` — what the client returns, plus the `Page` shape paging is
  written against.
- `live.test.mts` — runs the real query documents against Linear. Skipped
  unless `DISPATCH_LIVE_TESTS=1` and `LINEAR_API_KEY` are both set, because it
  is the only thing that catches a field the schema no longer has.

Two rules the queries encode, both learned from the tracker adapter:
archived issues are selected everywhere (Linear hides completed work by
default, and an archived ticket still counts toward its milestone), and issues
are paged in `createdAt` order, never `updatedAt`, so a row edited mid-scan
cannot move between pages and be missed.

The module is Linear's vocabulary, not dispatch's: it returns workflow-state
names and Linear priorities. Mapping those onto dispatch statuses belongs to
the caller, next to the rest of the tracker binding.
