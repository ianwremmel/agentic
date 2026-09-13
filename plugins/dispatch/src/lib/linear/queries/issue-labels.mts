/**
 * The rest of one issue's labels, by UUID and cursor. Reached only when an
 * issue overflowed its inline page, which is why the client keeps the UUID:
 * `issue(id:)` takes it, and nothing else can resume a nested connection.
 */
export const ISSUE_LABELS_QUERY = `query DispatchIssueLabels($id: String!, $first: Int!, $after: String) {
  issue(id: $id) {
    labels(first: $first, after: $after) {
      nodes { name }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;
