/**
 * Every field here is one the dispatch graph records. Nested connections take
 * a `first:` big enough for real tickets and are never paged: an issue with
 * more than 50 labels or 50 relations loses the overflow, which is a better
 * failure than a scan that fans out into hundreds of round trips.
 */
export const ISSUE_FIELDS = `fragment IssueFields on Issue {
  id
  identifier
  title
  url
  priority
  branchName
  updatedAt
  state { name type }
  project { id }
  projectMilestone { id }
  labels(first: 50) { nodes { name } }
  relations(first: 50) { nodes { type relatedIssue { identifier } } }
  inverseRelations(first: 50) { nodes { type issue { identifier } } }
}`;

export const PROJECTS_QUERY = `query DispatchProjects($first: Int!, $after: String) {
  projects(first: $first, after: $after) {
    nodes { id name url updatedAt }
    pageInfo { hasNextPage endCursor }
  }
}`;

export const MILESTONES_QUERY = `query DispatchMilestones($project: String!, $first: Int!, $after: String) {
  project(id: $project) {
    projectMilestones(first: $first, after: $after) {
      nodes { id name sortOrder }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

/**
 * The filter is a variable rather than inline arguments so an absent cursor
 * omits `updatedAt` entirely instead of comparing against null.
 *
 * Ordering is Linear's default (`createdAt`), deliberately not `updatedAt`:
 * paging a list ordered by the same field the rows are being mutated on
 * lets an issue move between pages and be skipped. The delta filter still
 * bounds what comes back.
 */
export const ISSUES_QUERY = `${ISSUE_FIELDS}

query DispatchIssues($filter: IssueFilter!, $first: Int!, $after: String) {
  issues(filter: $filter, first: $first, after: $after) {
    nodes { ...IssueFields }
    pageInfo { hasNextPage endCursor }
  }
}`;

/** One issue by human identifier: Linear's `issue(id:)` takes a UUID, this does not. */
export const ISSUE_QUERY = `${ISSUE_FIELDS}

query DispatchIssue($filter: IssueFilter!) {
  issues(filter: $filter, first: 1) {
    nodes { ...IssueFields }
  }
}`;
