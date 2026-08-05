import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {satisfied} from './condition.mts';
import type {PrSnapshot} from './snapshot.mts';

const BASE: PrSnapshot = {
  head: 'aaaaaaaa',
  state: 'OPEN',
  draft: false,
  merged: false,
  mergeable: 'MERGEABLE',
  mergeState: 'BLOCKED',
  reviewDecision: 'REVIEW_REQUIRED',
  rollup: null,
  checks: [{name: 'test', conclusion: null, url: null}],
  reviews: [],
  threads: [],
  comments: [],
  totals: {reviews: 0, threads: 0, comments: 0},
};

const snap = (over: Partial<PrSnapshot>): PrSnapshot => ({...BASE, ...over});
const check = (s: PrSnapshot, r: 'ci' | 'review' | 'merge'): boolean =>
  satisfied(r, s);

describe('satisfied', () => {
  it('does not end a merge wait just because the PR is mergeable', () => {
    // CLEAN is the state the worker waits *in*. Ending the wait here fires on
    // the first poll, and again every time the worker re-arms.
    assert.equal(check(snap({mergeState: 'CLEAN'}), 'merge'), false);
  });

  it('ends any wait on a terminal PR', () => {
    for (const reason of ['ci', 'review', 'merge'] as const) {
      assert.equal(check(snap({merged: true}), reason), true);
      assert.equal(check(snap({state: 'CLOSED'}), reason), true);
      // A conflict is actionable whatever the worker was waiting for.
      assert.equal(check(snap({mergeState: 'DIRTY'}), reason), true);
    }
  });

  it('ends a ci wait only once every check has reported', () => {
    assert.equal(check(BASE, 'ci'), false);
    assert.equal(
      check(
        snap({checks: [{name: 'test', conclusion: 'SUCCESS', url: null}]}),
        'ci'
      ),
      true
    );
    // Nothing to wait for beats hanging until expiry.
    assert.equal(check(snap({checks: []}), 'ci'), true);
  });

  it('never ends a review wait on a persistent verdict', () => {
    // reviewDecision stays CHANGES_REQUESTED after the worker addresses it,
    // until the reviewer looks again. Firing on it would wake the worker,
    // give it nothing new, and wake it again the moment it re-armed —
    // claiming the item and spending an admission every turn.
    const answered = snap({
      reviewDecision: 'CHANGES_REQUESTED',
      reviews: [
        {
          author: 'human',
          state: 'CHANGES_REQUESTED',
          submittedAt: 'x',
          mine: false,
        },
      ],
    });
    assert.equal(check(answered, 'review'), false);
    assert.equal(check(snap({reviewDecision: 'APPROVED'}), 'review'), false);
  });
});
