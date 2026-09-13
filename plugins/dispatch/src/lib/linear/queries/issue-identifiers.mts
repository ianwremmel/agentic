/** Identifiers alone: what a caller needs to tell a ticket that moved away from one it never saw. */
export const ISSUE_IDENTIFIERS_QUERY = `query DispatchIssueIdentifiers($filter: IssueFilter!, $first: Int!, $after: String) {
  issues(filter: $filter, first: $first, after: $after, includeArchived: true, orderBy: createdAt) {
    nodes { identifier }
    pageInfo { hasNextPage endCursor }
  }
}`;
