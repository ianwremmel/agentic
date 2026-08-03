import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {assertEnv} from './env.mts';
import {EnvironmentError} from '../errors/index.mts';

describe('assertEnv', () => {
  it('passes when every declared key is present', () => {
    assert.doesNotThrow(() => {
      assertEnv(['TOKEN'], {TOKEN: 'x'});
    });
  });

  it('passes when nothing is declared', () => {
    assert.doesNotThrow(() => {
      assertEnv([], {});
    });
  });

  it('throws EnvironmentError naming the missing keys', () => {
    assert.throws(
      () => {
        assertEnv(['TOKEN', 'REGION'], {TOKEN: 'x'});
      },
      (error: unknown) =>
        error instanceof EnvironmentError && error.message.includes('REGION')
    );
  });

  it('throws EnvironmentError naming all missing keys when several are absent', () => {
    assert.throws(
      () => {
        assertEnv(['TOKEN', 'REGION'], {});
      },
      (error: unknown) =>
        error instanceof EnvironmentError &&
        error.message.includes('TOKEN') &&
        error.message.includes('REGION')
    );
  });
});
