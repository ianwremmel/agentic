# linear

Reads the Linear workspace over its GraphQL API, so the server can answer a
`scan_project` or `fetch_ticket` instruction itself instead of pushing it to an
agent session. `@linear/sdk` supplies the GraphQL client and the generated
filter input types; the query documents are hand-written, because the SDK's
generated operations fetch labels, relations and state names as separate
documents — three or more extra round trips per issue, against an API that
rate-limits on complexity.

- `token.mts` — `LINEAR_API_KEY`, and which SDK credential slot it goes in.
- `transport.mts` — `createTransport`: one endpoint and key, a per-request
  timeout, the SDK's rejection restated on the dispatch error taxonomy.
- `faults.mts` — which taxonomy class a rejection lands on.
- `queries/` — one query document per file. Nothing mocked can check these; a
  selection Linear no longer answers only shows up in `live.test.mts`.
- `paging.mts`, `fields.mts` — walk a connection to its end; refuse a field
  that did not come back rather than default it.
- `parse-issue.mts` — one raw issue into a `LinearIssue`, finishing any nested
  connection that overflowed its inline page.
- `client.mts` — `LinearClient`, the reads the graph is built from. Every one
  takes a `signal`: the transport's timeout bounds one request, and a walk is
  many.
- `live.test.mts` — the real documents against Linear, skipped unless
  `DISPATCH_LIVE_TESTS=1` and `LINEAR_API_KEY` are both set. The only thing
  that catches a field the schema no longer has.

The module speaks Linear's vocabulary, not dispatch's: it returns workflow-state
names and Linear priorities. Mapping those onto dispatch statuses belongs to the
caller, next to the rest of the tracker binding.
