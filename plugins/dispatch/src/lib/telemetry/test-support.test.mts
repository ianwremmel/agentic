import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {childEnv, withoutOtelEnv} from './test-support.mts';

/**
 * These two guard every other test in this directory, and their failure mode
 * is silent: a suite that passes on a clean host and flakes wherever `OTEL_*`
 * happens to be exported. So they are pinned here rather than trusted.
 */

/**
 * Apply `overrides` for the length of `body`, then put the environment back
 * exactly as it was — a previous value restored, a key that had none removed.
 *
 * Deleting the keys afterwards instead would destroy whatever the host had
 * set, which is the very thing these tests exist to stop happening to
 * everything downstream of them.
 */
async function withEnv<T>(
  overrides: Record<string, string>,
  body: () => Promise<T> | T
): Promise<T> {
  const saved = Object.keys(overrides).map(
    (name) => [name, process.env[name]] as const
  );
  Object.assign(process.env, overrides);
  try {
    return await body();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) Reflect.deleteProperty(process.env, name);
      else process.env[name] = value;
    }
  }
}

describe('childEnv', () => {
  it('drops every OTEL_ key from what the child inherits', async () => {
    await withEnv(
      {
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://host:4318',
        OTEL_LOG_LEVEL: 'debug',
      },
      () => {
        assert.deepEqual(
          Object.keys(childEnv()).filter((name) => name.startsWith('OTEL_')),
          []
        );
      }
    );
  });

  it('keeps the rest, which the child needs to run at all', () => {
    assert.equal(childEnv().PATH, process.env.PATH);
  });

  it('applies the overrides a test asks for', async () => {
    await withEnv({OTEL_LOG_LEVEL: 'debug'}, () => {
      // The override wins over the host value rather than being dropped with
      // it — a test that configures the SDK deliberately has to be able to.
      assert.equal(childEnv({OTEL_LOG_LEVEL: 'warn'}).OTEL_LOG_LEVEL, 'warn');
    });
  });
});

describe('withoutOtelEnv', () => {
  it('hides the keys for the body and puts them back after', async () => {
    await withEnv({OTEL_LOG_LEVEL: 'debug'}, async () => {
      const during = await withoutOtelEnv(() =>
        Promise.resolve(process.env.OTEL_LOG_LEVEL)
      );

      assert.deepEqual(
        {after: process.env.OTEL_LOG_LEVEL, during},
        {after: 'debug', during: undefined}
      );
    });
  });

  it('puts them back when the body throws', async () => {
    // Otherwise one failing test silently reconfigures the SDK for every test
    // after it in the same file.
    await withEnv({OTEL_LOG_LEVEL: 'debug'}, async () => {
      await assert.rejects(
        withoutOtelEnv(() => Promise.reject(new Error('boom'))),
        /boom/u
      );

      assert.equal(process.env.OTEL_LOG_LEVEL, 'debug');
    });
  });

  it('removes a key the body added rather than leaving it behind', async () => {
    // Restoring only what was saved would let one test's leftovers configure
    // the SDK for the next one. The key is one no host would export, so that
    // "gone afterwards" means the body's own addition was removed rather than
    // a host value being restored over it.
    const added = 'OTEL_PROBE_ADDED_BY_THIS_TEST';

    await withoutOtelEnv(() => {
      process.env[added] = 'x';
      return Promise.resolve();
    });

    assert.equal(process.env[added], undefined);
  });
});
