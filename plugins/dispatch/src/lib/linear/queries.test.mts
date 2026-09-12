import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {
  ISSUES_QUERY,
  ISSUE_FIELDS,
  ISSUE_IDENTIFIERS_QUERY,
  ISSUE_INVERSE_RELATIONS_QUERY,
  ISSUE_LABELS_QUERY,
  ISSUE_QUERY,
  ISSUE_RELATIONS_QUERY,
  MILESTONES_QUERY,
  PROJECTS_QUERY,
} from './queries.mts';

/**
 * The query documents, tested directly. A mocked executor answers whatever the
 * fixture says whatever the document asked for, so dropping a selection breaks
 * nothing there and everything against Linear — these are the assertions that
 * fail instead.
 */

const ISSUE_QUERIES = {
  ISSUES_QUERY,
  ISSUE_IDENTIFIERS_QUERY,
  ISSUE_QUERY,
};

const PAGED_QUERIES = {
  PROJECTS_QUERY,
  MILESTONES_QUERY,
  ISSUES_QUERY,
  ISSUE_IDENTIFIERS_QUERY,
  ISSUE_LABELS_QUERY,
  ISSUE_RELATIONS_QUERY,
  ISSUE_INVERSE_RELATIONS_QUERY,
};

describe('query documents', () => {
  it('selects archived work everywhere, or a completed ticket reads as deleted', () => {
    for (const [name, query] of Object.entries({
      PROJECTS_QUERY,
      MILESTONES_QUERY,
      ...ISSUE_QUERIES,
    })) {
      assert.ok(
        query.includes('includeArchived: true'),
        `${name} must ask for archived rows`
      );
    }
  });

  it('orders issues on a field no edit moves, so paging cannot skip a row', () => {
    for (const [name, query] of Object.entries({
      ISSUES_QUERY,
      ISSUE_IDENTIFIERS_QUERY,
    })) {
      assert.ok(
        query.includes('orderBy: createdAt'),
        `${name} must order on createdAt`
      );
      assert.ok(
        !query.includes('orderBy: updatedAt'),
        `${name} must not order on the field its rows are mutated on`
      );
    }
  });

  it('asks for every field the graph is written from', () => {
    for (const field of [
      'id',
      'identifier',
      'title',
      'url',
      'priority',
      'branchName',
      'updatedAt',
      'archivedAt',
      'state { name type }',
      'project { id }',
      'projectMilestone { id }',
    ]) {
      assert.ok(ISSUE_FIELDS.includes(field), `missing ${field}`);
    }
  });

  it('reads both ends of a relation, since one end alone cannot say which way it points', () => {
    assert.ok(ISSUE_FIELDS.includes('relations(first:'));
    assert.ok(ISSUE_FIELDS.includes('inverseRelations(first:'));
    assert.ok(
      ISSUE_FIELDS.includes('nodes { type relatedIssue { identifier } }')
    );
    assert.ok(ISSUE_FIELDS.includes('nodes { type issue { identifier } }'));
  });

  it('asks every pageable connection for the cursor that resumes it', () => {
    for (const [name, query] of Object.entries(PAGED_QUERIES)) {
      assert.ok(
        query.includes('pageInfo { hasNextPage endCursor }'),
        `${name} must select the cursor it pages on`
      );
      assert.ok(
        query.includes('$after'),
        `${name} must accept a cursor to resume from`
      );
    }
  });

  it('gives every nested connection on an issue a cursor of its own', () => {
    const cursors = ISSUE_FIELDS.match(
      /pageInfo \{ hasNextPage endCursor \}/gu
    );
    assert.equal(
      cursors?.length,
      3,
      'labels, relations and inverseRelations each need one to be resumable'
    );
  });

  it('looks an issue up by team and number, which is what a caller holds', () => {
    assert.ok(ISSUE_QUERY.includes('$filter: IssueFilter!'));
    assert.ok(!ISSUE_QUERY.includes('issue(id:'));
  });

  it('resumes a nested connection by the uuid the issue fields carry', () => {
    for (const [name, query] of Object.entries({
      ISSUE_LABELS_QUERY,
      ISSUE_RELATIONS_QUERY,
      ISSUE_INVERSE_RELATIONS_QUERY,
    })) {
      assert.ok(query.includes('issue(id: $id)'), `${name} resumes by uuid`);
    }
  });
});
