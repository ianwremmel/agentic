import {ISSUE_FIELDS} from './issue-fields.mts';

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
