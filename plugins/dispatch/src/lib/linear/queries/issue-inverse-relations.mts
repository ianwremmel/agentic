/** The rest of one issue's incoming relations, by UUID and cursor. */
export const ISSUE_INVERSE_RELATIONS_QUERY = `query DispatchIssueInverseRelations($id: String!, $first: Int!, $after: String) {
  issue(id: $id) {
    inverseRelations(first: $first, after: $after) {
      nodes { type issue { identifier } }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;
