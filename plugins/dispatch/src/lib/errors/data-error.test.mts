import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {DataError} from './data-error.mts';
import {CommandError, DispatchError} from './index.mts';

describe('DataError', () => {
  it('is a CommandError with exit code 4 and renders its hint', () => {
    const err = new DataError('that edge would create a cycle', {
      hint: 'remove the opposing edge first.',
    });
    assert.ok(err instanceof CommandError);
    assert.ok(err instanceof DispatchError);
    assert.equal(err.exitCode, 4);
    assert.equal(err.name, 'DataError');
    assert.match(err.toString(), /hint: remove the opposing edge first\./u);
  });
});
