import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {DataError} from '../errors/index.mts';
import {statusOfLinearState} from './linear-status.mts';

describe('statusOfLinearState', () => {
  it('separates the four started substates, which share one Linear group', () => {
    const started = (name: string): string =>
      statusOfLinearState({name, type: 'started'});
    assert.equal(started('In Progress'), 'in-progress');
    assert.equal(started('In Review'), 'in-review');
    assert.equal(started('Finished'), 'finished');
    assert.equal(started('Delivered'), 'delivered');
  });

  it('reads a completed substate by its group, whatever the team named it', () => {
    assert.equal(
      statusOfLinearState({name: 'Done', type: 'completed'}),
      'verified'
    );
    assert.equal(
      statusOfLinearState({name: 'Shipped', type: 'completed'}),
      'verified'
    );
    assert.equal(
      statusOfLinearState({name: 'Duplicate', type: 'canceled'}),
      'canceled'
    );
    assert.equal(
      statusOfLinearState({name: 'Triage', type: 'triage'}),
      'backlog'
    );
  });

  it('matches a substate name case- and space-insensitively', () => {
    assert.equal(
      statusOfLinearState({name: '  IN PROGRESS ', type: 'started'}),
      'in-progress'
    );
  });

  it('refuses an unstarted substate that is not Todo rather than calling it available', () => {
    // A team's own Blocked sits in `unstarted` beside Todo. Read as available it
    // would dispatch work that cannot start, so the scan has to hand back to the
    // agent instead.
    assert.throws(
      () => statusOfLinearState({name: 'Blocked', type: 'unstarted'}),
      (error: unknown) =>
        error instanceof DataError &&
        error.message.includes('has no dispatch status')
    );
  });

  it('refuses an unnamed started substate, which could be any of four roles', () => {
    assert.throws(
      () => statusOfLinearState({name: 'Needs QA', type: 'started'}),
      DataError
    );
  });
});
