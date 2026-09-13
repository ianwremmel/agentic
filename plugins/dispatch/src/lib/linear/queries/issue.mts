import {ISSUE_FIELDS} from './issue-fields.mts';

/** One issue by human identifier: Linear's `issue(id:)` takes a UUID, this does not. */
export const ISSUE_QUERY = `${ISSUE_FIELDS}

query DispatchIssue($filter: IssueFilter!) {
  issues(filter: $filter, first: 1, includeArchived: true) {
    nodes { ...IssueFields }
  }
}`;
