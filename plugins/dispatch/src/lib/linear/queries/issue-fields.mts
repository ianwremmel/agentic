import {NESTED_PAGE_SIZE} from '../paging.mts';

/**
 * Every issue field the scan reads, in one round trip. Archived issues are
 * selected wherever this is used: Linear archives completed work and hides it
 * from every connection by default, and an archived ticket still counts toward
 * its milestone — a scan that cannot see it reads as a ticket that no longer
 * exists.
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
