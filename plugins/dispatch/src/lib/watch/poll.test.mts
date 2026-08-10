import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {tempEnv} from '../command/test-support.mts';
import {withDatabase} from '../db/index.mts';
import {
  CoordinationStore,
  PrEventStore,
  PrStore,
  WatchStore,
} from '../stores/index.mts';
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
      // Past the fixture's expiry.
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

  it('watches a PR item nobody yielded', async () => {
    const env = await tempEnv();
    await withDatabase(undefined, env, async (db) => {
      await new PrStore(db).upsertPr({
        id: 'owner/repo#2',
        ticket: null,
        origin: 'prompt',
        repo: 'owner/repo',
        prNumber: 2,
        url: null,
        branch: null,
        title: 'unwatched',
        injected: false,
        priority: null,
        updatedAt: NOW,
      });
    });

    // A PR moves whether or not a worker asked anyone to look. The item
    // nobody armed is exactly the one whose change would go unnoticed.
    await pollWatches(env, {snapshot: snapshotter(BASE), now: () => LATER});

    await withDatabase(undefined, env, async (db) => {
      assert.equal(
        (await new WatchStore(db).get('owner/repo#2'))?.state,
        'watching'
      );
    });
  });

  it('watches a PR item parked on an operator', async () => {
    const env = await tempEnv();
    await withDatabase(undefined, env, async (db) => {
      await new PrStore(db).upsertPr({
        id: 'owner/repo#4',
        ticket: null,
        origin: 'prompt',
        repo: 'owner/repo',
        prNumber: 4,
        url: null,
        branch: null,
        title: 'parked',
        injected: false,
        priority: null,
        updatedAt: NOW,
      });
      await new CoordinationStore(db).recordOutcome(
        {
          node: 'owner/repo#4',
          outcome: 'human-blocked',
          retryable: null,
          detail: 'is the deploy pipeline meant to be red?',
          recordedAt: NOW,
        },
        {session: ''}
      );
    });

    // The park never armed a watch — nothing to keep — so the pass has to
    // open one, or the operator's answer lands where nobody is looking.
    await pollWatches(env, {snapshot: snapshotter(BASE), now: () => LATER});

    await withDatabase(undefined, env, async (db) => {
      assert.equal(
        (await new WatchStore(db).get('owner/repo#4'))?.state,
        'watching'
      );
    });
  });

  it('re-arms rather than fires an expired watch on a parked item', async () => {
    const env = await tempEnv();
    await fixture(env, BASE);
    await withDatabase(undefined, env, async (db) => {
      await new CoordinationStore(db).recordOutcome(
        {
          node: 'owner/repo#1',
          outcome: 'human-blocked',
          retryable: null,
          detail: null,
          recordedAt: NOW,
        },
        {session: 'S1'}
      );
    });

    const {fired} = await pollWatches(env, {
      snapshot: snapshotter(BASE),
      // Well past the fixture's expiry.
      now: () => '2026-08-05T20:00:00.000Z',
    });

    // Expiry sends a worker to look for itself, and a parked item has none.
    // Firing here would re-dispatch on a deadline rather than on an answer.
    assert.deepEqual(fired, []);
    await withDatabase(undefined, env, async (db) => {
      assert.equal(
        (await new WatchStore(db).get('owner/repo#1'))?.state,
        'watching'
      );
      // The poll pushed the expiry out, so the row is not perpetually due.
      assert.deepEqual(
        await new WatchStore(db).due('2026-08-05T20:00:01.000Z', 5),
        []
      );
    });
  });

  it('does not watch an item that already concluded', async () => {
    const env = await tempEnv();
    await withDatabase(undefined, env, async (db) => {
      await new PrStore(db).upsertPr({
        id: 'owner/repo#3',
        ticket: null,
        origin: 'prompt',
        repo: 'owner/repo',
        prNumber: 3,
        url: null,
        branch: null,
        title: 'done',
        injected: false,
        priority: null,
        updatedAt: NOW,
      });
      await new CoordinationStore(db).recordOutcome(
        {
          node: 'owner/repo#3',
          outcome: 'delivered',
          retryable: null,
          detail: null,
          recordedAt: NOW,
        },
        {session: ''}
      );
    });

    await pollWatches(env, {snapshot: snapshotter(BASE), now: () => LATER});

    await withDatabase(undefined, env, async (db) => {
      assert.equal(await new WatchStore(db).get('owner/repo#3'), null);
    });
  });
});
