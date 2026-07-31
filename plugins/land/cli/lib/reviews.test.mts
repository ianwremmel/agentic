import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {
  reviewsXml,
  type ReviewNode,
  type ReviewRequestNode,
  type ReviewsInput,
} from './reviews.mts';

function input(
  reviews: readonly ReviewNode[],
  requests: readonly ReviewRequestNode[] = []
): ReviewsInput {
  return {reviews: {nodes: reviews}, reviewRequests: {nodes: requests}};
}

describe('reviewsXml', () => {
  it('keeps the latest submitted review per author', () => {
    const xml = reviewsXml(
      input([
        {author: {login: 'alice'}, state: 'COMMENTED'},
        {author: {login: 'alice'}, state: 'APPROVED'},
      ]),
      'operator'
    );
    const rows = xml.match(/<review /gu) ?? [];
    assert.equal(rows.length, 1, 'one row per reviewer');
    assert.match(xml, /author="alice"[^/]*state="approved"/u);
  });

  it('drops an unsubmitted (PENDING) draft review — it is author-only', () => {
    const xml = reviewsXml(
      input([{author: {login: 'alice'}, state: 'PENDING'}]),
      'operator'
    );
    assert.doesNotMatch(xml, /author="alice"/u);
  });

  it('overrides a prior verdict back to pending when a fresh request stands', () => {
    const xml = reviewsXml(
      input(
        [{author: {login: 'copilot', __typename: 'Bot'}, state: 'APPROVED'}],
        [{requestedReviewer: {__typename: 'Bot', login: 'copilot'}}]
      ),
      'operator'
    );
    assert.match(xml, /author="copilot"[^/]*state="pending"/u);
  });

  it('adds a pending stub for a requested reviewer that has not reviewed', () => {
    const xml = reviewsXml(
      input([], [{requestedReviewer: {__typename: 'User', login: 'bob'}}]),
      'operator'
    );
    assert.match(xml, /author="bob" mode="human" role="team" state="pending"/u);
  });

  it('marks the configured operator with role=operator', () => {
    const xml = reviewsXml(
      input([{author: {login: 'Operator'}, state: 'APPROVED'}]),
      'operator'
    );
    assert.match(
      xml,
      /author="Operator" mode="human" role="operator" state="approved"/u
    );
  });

  it('treats a GitHub Bot and known agent logins as mode=bot with no role', () => {
    const xml = reviewsXml(
      input([
        {author: {login: 'dependabot', __typename: 'Bot'}, state: 'COMMENTED'},
        {author: {login: 'claude-agent'}, state: 'COMMENTED'},
      ]),
      'operator'
    );
    assert.match(xml, /author="dependabot" mode="bot" state="commented"\/>/u);
    assert.match(xml, /author="claude-agent" mode="bot" state="commented"\/>/u);
  });
});
