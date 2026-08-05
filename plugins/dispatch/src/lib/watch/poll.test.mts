import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {tempEnv} from '../command/test-support.mts';
import {withDatabase} from '../db/index.mts';
import {PrEventStore, PrStore, WatchStore} from '../stores/index.mts';
import {pollWatches} from './poll.mts';
import type {PrSnapshot, Snapshotter} from './snapshot.mts';

const NOW = '2026-08-05T12:00:00.000Z';
const LATER = '2026-08-05T12:30:00.000Z';

const BASE: PrSnapshot = {
  head: 'aaaaaaaa',
  state: 'OPEN',
  draft: false,
  merged: false,
  mergeable: 'MERGEABLE',
  mergeState: 'BLOCKED',
  reviewDecision: 'REVIEW_REQUIRED',
  rollup: 'SUCCESS',
  checks: [{name: 'test', conclusion: null, url: null}],
  reviews: [],
  threads: [],
  comments: [],
  totals: {reviews: 0, threads: 0, comments: 0},
};

async function fixture(
  env: NodeJS.ProcessEnv,
  snapshot: PrSnapshot | null
): Promise<void> {
  await withDatabase(undefined, env, async (db) => {
    await new PrStore(db).upsertPr({
      id: 'owner/repo#1',
      ticket: null,
      origin: 'prompt',
      repo: 'owner/repo',
      prNumber: 1,
      url: null,
      branch: null,
      title: 'thing',
      injected: false,
      priority: null,
      updatedAt: NOW,
    });
    await new WatchStore(db).set({
      node: 'owner/repo#1',
      reason: 'ci',
      intervalSeconds: 60,
      at: NOW,
      expiresAt: '2026-08-05T13:00:00.000Z',
      snapshot,
      session: 'S1',
    });
  });
}

function snapshotter(next: PrSnapshot): Snapshotter {
  return async () => Promise.resolve(next);
}

describe('pollWatches', () => {
  it('leaves the watch armed when nothing a worker would act on changed', async () => {
    const env = await tempEnv();
    await fixture(env, BASE);

    const {fired} = await pollWatches(env, {
      snapshot: snapshotter(BASE),
      now: () => LATER,
    });

    assert.deepEqual(fired, []);
    await withDatabase(undefined, env, async (db) => {
      assert.equal(
        (await new WatchStore(db).get('owner/repo#1'))?.state,
        'watching'
      );
      assert.deepEqual(await new PrEventStore(db).undelivered('S1'), []);
    });
  });

  it('fires with named events when the PR changed', async () => {
    const env = await tempEnv();
    await fixture(env, BASE);

    const {fired} = await pollWatches(env, {
      snapshot: snapshotter({
        ...BASE,
        checks: [{name: 'test', conclusion: 'FAILURE', url: 'https://ci/1'}],
      }),
      now: () => LATER,
    });

    assert.deepEqual(fired, ['owner/repo#1']);
    await withDatabase(undefined, env, async (db) => {
      assert.equal(
        (await new WatchStore(db).get('owner/repo#1'))?.state,
        'fired'
      );
      const events = await new PrEventStore(db).undelivered('S1');
      assert.deepEqual(
        events.map((event) => event.kind),
        ['ci_finished']
      );
      assert.equal(events[0]?.meta.failing, 'test');
    });
  });

  it("does not fire on the agent's own comment", async () => {
    const env = await tempEnv();
    await fixture(env, BASE);

    const {fired} = await pollWatches(env, {
      snapshot: snapshotter({
        ...BASE,
        comments: [{id: 'c1', author: 'agent', createdAt: LATER, mine: true}],
      }),
      now: () => LATER,
    });

    // The snapshot moved, but only because the worker wrote to its own PR.
    assert.deepEqual(fired, []);
    await withDatabase(undefined, env, async (db) => {
      assert.deepEqual(await new PrEventStore(db).undelivered('S1'), []);
    });
  });

  it('primes without firing when the watch was armed with no baseline', async () => {
    const env = await tempEnv();
    await fixture(env, null);

    const {fired} = await pollWatches(env, {
      snapshot: snapshotter(BASE),
      now: () => LATER,
    });

    assert.deepEqual(fired, []);
    await withDatabase(undefined, env, async (db) => {
      // The snapshot is now stored, so the *next* poll can diff against it.
      const due = await new WatchStore(db).due('2026-08-05T13:30:00.000Z', 5);
      assert.equal(due[0]?.snapshot?.head, 'aaaaaaaa');
    });
  });

  it('fires an expired watch without reading the PR', async () => {
    const env = await tempEnv();
    await fixture(env, BASE);

    const {fired} = await pollWatches(env, {
      snapshot: () => {
        throw new Error('must not be called for an expired watch');
      },
      // Past the fixture's one-hour expiry.
      now: () => '2026-08-05T14:00:00.000Z',
    });

    // Expiry is the safety net for signals the snapshot cannot see, so it
    // fires with no events — the worker goes and looks for itself.
    assert.deepEqual(fired, ['owner/repo#1']);
    await withDatabase(undefined, env, async (db) => {
      assert.deepEqual(await new PrEventStore(db).undelivered('S1'), []);
    });
  });

  it('delays a failed read by one interval instead of failing the pass', async () => {
    const env = await tempEnv();
    await fixture(env, BASE);

    const {fired} = await pollWatches(env, {
      snapshot: () => Promise.reject(new Error('gh exploded')),
      now: () => LATER,
    });

    assert.deepEqual(fired, []);
    await withDatabase(undefined, env, async (db) => {
      // checked_at moved, so the row is not due again immediately.
      const due = await new WatchStore(db).due(LATER, 5);
      assert.deepEqual(due, []);
      assert.equal(
        (await new WatchStore(db).get('owner/repo#1'))?.state,
        'watching'
      );
    });
  });
});
