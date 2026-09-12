/**
 * How many labels or relations one issue's page carries inline. Asking for
 * more multiplies Linear's complexity cost by every issue in the page, so an
 * issue that overflows this is finished with its own follow-up request instead:
 * the common issue costs nothing extra, and the hub ticket with sixty links
 * still comes back whole.
 */
export const NESTED_PAGE_SIZE = 50;

/**
 * Archived issues are selected everywhere. Linear archives completed work and
 * hides it from every connection by default, and an archived ticket still
 * counts toward its milestone — a scan that cannot see it reads as a ticket
 * that no longer exists.
 */
export const ISSUE_FIELDS = `fragment IssueFields on Issue {
  id
  identifier
  title
  url
  priority
  branchName
  updatedAt
  archivedAt
  state { name type }
  project { id }
  projectMilestone { id }
  labels(first: ${String(NESTED_PAGE_SIZE)}) {
    nodes { name }
    pageInfo { hasNextPage endCursor }
  }
  relations(first: ${String(NESTED_PAGE_SIZE)}) {
    nodes { type relatedIssue { identifier } }
    pageInfo { hasNextPage endCursor }
  }
  inverseRelations(first: ${String(NESTED_PAGE_SIZE)}) {
    nodes { type issue { identifier } }
    pageInfo { hasNextPage endCursor }
  }
}`;

/**
 * The rest of one issue's nested connection, by UUID and cursor. Reached only
 * when an issue overflowed its inline page, which is why the client keeps the
 * UUID: `issue(id:)` takes it, and nothing else can resume a nested connection.
 */
export const ISSUE_LABELS_QUERY = `query DispatchIssueLabels($id: String!, $first: Int!, $after: String) {
  issue(id: $id) {
    labels(first: $first, after: $after) {
      nodes { name }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

export const ISSUE_RELATIONS_QUERY = `query DispatchIssueRelations($id: String!, $first: Int!, $after: String) {
  issue(id: $id) {
    relations(first: $first, after: $after) {
      nodes { type relatedIssue { identifier } }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

export const ISSUE_INVERSE_RELATIONS_QUERY = `query DispatchIssueInverseRelations($id: String!, $first: Int!, $after: String) {
  issue(id: $id) {
    inverseRelations(first: $first, after: $after) {
      nodes { type issue { identifier } }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

export const PROJECTS_QUERY = `query DispatchProjects($filter: ProjectFilter, $first: Int!, $after: String) {
  projects(filter: $filter, first: $first, after: $after, includeArchived: true) {
    nodes { id name }
    pageInfo { hasNextPage endCursor }
  }
}`;

export const MILESTONES_QUERY = `query DispatchMilestones($project: String!, $first: Int!, $after: String) {
  project(id: $project) {
    projectMilestones(first: $first, after: $after, includeArchived: true) {
      nodes { id name sortOrder }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

/**
 * The filter is a variable rather than inline arguments so an absent cursor
 * omits `updatedAt` entirely instead of comparing against null.
 *
 * `orderBy` is written out rather than left to the server default, and it is
 * `createdAt` deliberately: paging a list ordered by the field its rows are
 * being mutated on lets an issue move between pages and be skipped. `createdAt`
 * never moves.
 */
export const ISSUES_QUERY = `${ISSUE_FIELDS}

query DispatchIssues($filter: IssueFilter!, $first: Int!, $after: String) {
  issues(filter: $filter, first: $first, after: $after, includeArchived: true, orderBy: createdAt) {
    nodes { ...IssueFields }
    pageInfo { hasNextPage endCursor }
  }
}`;

/** Identifiers alone: what a caller needs to tell a ticket that moved away from one it never saw. */
export const ISSUE_IDENTIFIERS_QUERY = `query DispatchIssueIdentifiers($filter: IssueFilter!, $first: Int!, $after: String) {
  issues(filter: $filter, first: $first, after: $after, includeArchived: true, orderBy: createdAt) {
    nodes { identifier }
    pageInfo { hasNextPage endCursor }
  }
}`;

/** One issue by human identifier: Linear's `issue(id:)` takes a UUID, this does not. */
export const ISSUE_QUERY = `${ISSUE_FIELDS}

query DispatchIssue($filter: IssueFilter!) {
  issues(filter: $filter, first: 1, includeArchived: true) {
    nodes { ...IssueFields }
  }
}`;
