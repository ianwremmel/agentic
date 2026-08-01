import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {DataError} from '../errors/index.mts';
import {assertInstant, nowIso} from './time.mts';

describe('nowIso', () => {
  it('returns a Zulu ISO-8601 instant', () => {
    assert.match(nowIso(), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
  });
});

describe('assertInstant', () => {
  it('accepts an RFC 3339 instant', () => {
    assert.doesNotThrow(() => {
      assertInstant('2026-07-31T12:00:00.000Z', '--at');
    });
  });

  it('rejects a non-timestamp with a DataError naming the field', () => {
    assert.throws(
      () => {
        assertInstant('07/31/2026', '--at');
      },
      (err: unknown) => err instanceof DataError && /--at/u.test(err.message)
    );
  });
});
