import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {DataError} from '../errors.mts';
import {WaitStore} from './store.mts';

describe('wait history', () => {
  it('computes the median per kind, averaging an even-count middle pair', async () => {
    const store = await WaitStore.open(':memory:');
    for (const elapsedS of [100, 300, 200]) {
      await store.record({repo: 'o/r', kind: 'ci', elapsedS, outcome: null}, 1);
    }
    assert.deepEqual(await store.stats('o/r'), [
      {kind: 'ci', count: 3, medianS: 200},
    ]);

    await store.record(
      {repo: 'o/r', kind: 'ci', elapsedS: 400, outcome: 'passed'},
      2
    );
    assert.deepEqual(await store.stats('o/r'), [
      {kind: 'ci', count: 4, medianS: 250},
    ]);
    await store.close();
  });

  it('keeps repos and kinds apart', async () => {
    const store = await WaitStore.open(':memory:');
    await store.record(
      {repo: 'o/r', kind: 'reviewer', elapsedS: 900, outcome: null},
      1
    );
    await store.record(
      {repo: 'o/other', kind: 'reviewer', elapsedS: 5, outcome: null},
      1
    );

    assert.deepEqual(await store.stats('o/r'), [
      {kind: 'reviewer', count: 1, medianS: 900},
    ]);
    await store.close();
  });

  it('caps history at 100 samples per repo and kind, dropping the oldest', async () => {
    const store = await WaitStore.open(':memory:');
    // 100 old outliers, then 5 fresh fast samples: the cap must evict the
    // oldest 5, moving the median, not just bound the count.
    for (let n = 0; n < 100; n += 1) {
      await store.record(
        {repo: 'o/r', kind: 'merge', elapsedS: 1000, outcome: null},
        n
      );
    }
    for (let n = 0; n < 5; n += 1) {
      await store.record(
        {repo: 'o/r', kind: 'merge', elapsedS: 10, outcome: null},
        100 + n
      );
    }

    const [stats] = await store.stats('o/r');
    assert.equal(stats?.count, 100);
    await store.close();
  });

  it('rejects a fractional or negative elapsed time', async () => {
    const store = await WaitStore.open(':memory:');
    await assert.rejects(
      store.record({repo: 'o/r', kind: 'ci', elapsedS: -1, outcome: null}, 1),
      DataError
    );
    await assert.rejects(
      store.record({repo: 'o/r', kind: 'ci', elapsedS: 1.5, outcome: null}, 1),
      DataError
    );
    await store.close();
  });
});
