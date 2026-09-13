/** The rest of one issue's outgoing relations, by UUID and cursor. */
export const ISSUE_RELATIONS_QUERY = `query DispatchIssueRelations($id: String!, $first: Int!, $after: String) {
  issue(id: $id) {
    relations(first: $first, after: $after) {
      nodes { type relatedIssue { identifier } }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;
