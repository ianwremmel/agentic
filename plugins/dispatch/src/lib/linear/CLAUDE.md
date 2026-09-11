# linear

Reads the Linear workspace over its GraphQL API, so the server can answer a
`scan_project` or `fetch_ticket` instruction itself instead of pushing it to an
agent session. No dependencies: `fetch`, injected so tests need no socket.

- `transport.mts` — `createTransport` (one endpoint + key, per-request timeout,
  HTTP status and GraphQL `errors[]` mapped onto the error taxonomy),
  `hasLinearToken` / `requireLinearToken` for `LINEAR_API_KEY`.
- `queries.mts` — the query documents. Fields are exactly what the graph
  records; nested connections are never paged.
- `client.mts` — `LinearClient`: `listProjects`, `listMilestones`,
  `listIssues` (delta-filtered on `updatedAt`), `getIssue` (by identifier,
  `null` when absent). Every method pages to completion.
- `types.mts` — what the client returns.

The module is Linear's vocabulary, not dispatch's: it returns workflow-state
names and Linear priorities. Mapping those onto dispatch statuses belongs to
the caller, next to the rest of the tracker binding.
