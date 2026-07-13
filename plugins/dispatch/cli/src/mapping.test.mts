import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DataError } from './errors.mts';
import { resolveRole } from './mapping.mts';

describe('state mapping', () => {
  it('resolves a team override before the tracker is even considered', () => {
    // The documented order is team override → tracker default → error. Checking
    // the tracker first would mean a team that has mapped every one of its
    // states in config still could not use a tracker with no built-in table —
    // which is precisely what the override exists to make possible.
    const role = resolveRole('jira', 'Ready for QA', {
      'ready for qa': 'in-review',
    });

    assert.equal(role, 'in-review');
  });

  it('falls back to the tracker default', () => {
    assert.equal(resolveRole('linear', 'In Review'), 'in-review');
    assert.equal(resolveRole('linear', 'Done'), 'verified');
  });

  it('errors on an unknown tracker only when no override covers the state', () => {
    assert.throws(
      () => resolveRole('jira', 'Ready for QA'),
      (error: unknown) => {
        assert.ok(error instanceof DataError);
        assert.match(error.message, /no mapping for the native state/);
        assert.match(error.remedy, /map every one of this tracker's states/);
        return true;
      },
    );
  });

  it('never guesses at a state the tracker default does not cover', () => {
    assert.throws(() => resolveRole('linear', 'Ready for QA'), DataError);
  });
});
