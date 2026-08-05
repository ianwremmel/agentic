import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {tempEnv} from '../command/test-support.mts';
import {withDatabase} from '../db/index.mts';
import type {Database} from '../db/database.mts';
import {PrStore, WatchStore} from '../stores/index.mts';
import {armWatch} from './arm.mts';
import {pollWatches} from './poll.mts';

const AT = '2026-08-05T00:00:00Z';

async function seedPr(db: Database): Promise<void> {
  await new PrStore(db).upsertPr({
    id: 'o/r#1',
    ticket: null,
    origin: 'prompt',
    repo: 'o/r',
    prNumber: 1,
    url: null,
    branch: null,
    title: 't',
    injected: false,
    priority: null,
    updatedAt: null,
  });
}

describe('armWatch', () => {
  it('arms with the current fingerprint, so a change that already landed fires on the first poll', async () => {
    const env = await tempEnv();
    await withDatabase(undefined, env, async (db) => {
      await seedPr(db);
      await armWatch(db, {
        node: 'o/r#1',
        reason: 'ci',
        repo: 'o/r',
        prNumber: 1,
        at: AT,
        fingerprint: () => Promise.resolve('at-arm-time'),
      });
    });

    // The PR changed between the worker's arm and the first server poll.
    const result = await pollWatches(env, {
      fingerprint: () => Promise.resolve('already-different'),
      now: () => '2026-08-05T00:00:30Z',
    });
    assert.deepEqual(result, {fired: ['o/r#1']});
  });

  it('degrades to priming when the baseline fingerprint fails', async () => {
    const env = await tempEnv();
    await withDatabase(undefined, env, async (db) => {
      await seedPr(db);
      await armWatch(db, {
        node: 'o/r#1',
        reason: 'ci',
        repo: 'o/r',
        prNumber: 1,
        at: AT,
        fingerprint: () => Promise.reject(new Error('gh down')),
      });
    });

    assert.deepEqual(
      await pollWatches(env, {
        fingerprint: () => Promise.resolve('a'),
        now: () => '2026-08-05T00:01:00Z',
      }),
      {fired: []}
    );
    assert.deepEqual(
      await pollWatches(env, {
        fingerprint: () => Promise.resolve('b'),
        now: () => '2026-08-05T00:02:30Z',
      }),
      {fired: ['o/r#1']}
    );
  });
});

describe('pollWatches', () => {
  it('an expired watch fires without a fingerprint call', async () => {
    const env = await tempEnv();
    await withDatabase(undefined, env, async (db) => {
      await seedPr(db);
      await new WatchStore(db).set({
        node: 'o/r#1',
        reason: 'review',
        intervalSeconds: 300,
        at: AT,
        expiresAt: AT,
        fingerprint: 'anything',
      });
    });

    let called = 0;
    const result = await pollWatches(env, {
      fingerprint: () => {
        called += 1;
        return Promise.resolve('x');
      },
      now: () => '2026-08-05T00:00:01Z',
    });
    assert.deepEqual(result, {fired: ['o/r#1']});
    assert.equal(called, 0);
  });

  it('a failed fingerprint delays the retry instead of failing the pass', async () => {
    const env = await tempEnv();
    await withDatabase(undefined, env, async (db) => {
      await seedPr(db);
      await new WatchStore(db).set({
        node: 'o/r#1',
        reason: 'ci',
        intervalSeconds: 60,
        at: AT,
        expiresAt: '2026-08-06T00:00:00Z',
        fingerprint: null,
      });
    });

    const fingerprint = () => Promise.reject(new Error('gh unavailable'));
    assert.deepEqual(
      await pollWatches(env, {fingerprint, now: () => '2026-08-05T00:00:30Z'}),
      {fired: []}
    );
    await withDatabase(undefined, env, async (db) => {
      const watches = new WatchStore(db);
      assert.deepEqual(await watches.get('o/r#1'), {
        reason: 'ci',
        state: 'watching',
      });
      // checked_at was touched, so the row waits out its interval before
      // the next attempt.
      assert.equal((await watches.due('2026-08-05T00:01:00Z', 10)).length, 0);
    });
  });
});
