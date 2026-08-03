import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {
  GROUP_OF,
  isResolved,
  isStatus,
  isTargetKind,
  isPrOrigin,
  STATUSES,
} from './status.mts';

describe('status vocabulary', () => {
  it('classifies every status into a group', () => {
    for (const status of STATUSES) {
      assert.ok(GROUP_OF[status], `${status} has a group`);
    }
  });

  it('treats verified and canceled as resolved, others not', () => {
    assert.equal(isResolved('verified'), true);
    assert.equal(isResolved('canceled'), true);
    assert.equal(isResolved('in-progress'), false);
  });

  it('guards reject unknown values', () => {
    assert.equal(isStatus('available'), true);
    assert.equal(isStatus('nope'), false);
    assert.equal(isTargetKind('pr'), true);
    assert.equal(isTargetKind('bare-pr'), false);
    assert.equal(isPrOrigin('resumed'), true);
    assert.equal(isPrOrigin('reopened'), false);
  });
});
