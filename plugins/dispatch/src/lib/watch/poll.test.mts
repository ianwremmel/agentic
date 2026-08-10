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

    // Expiry is the safety net for signals the snapshot cannot see. It has no
    // diff to report, but it must still say something: a fired watch is no
    // longer polled, so a silent fire leaves the item unreachable.
    assert.deepEqual(fired, ['owner/repo#1']);
    await withDatabase(undefined, env, async (db) => {
      const events = await new PrEventStore(db).undelivered('S1');
      assert.deepEqual(
        events.map((event) => event.kind),
        ['watch_expired']
      );
    });
  });

  it('starts a fresh wait when an expired watch is re-armed', async () => {
    const env = await tempEnv();
    await fixture(env, BASE);

    await pollWatches(env, {
      snapshot: () => {
        throw new Error('must not be called for an expired watch');
      },
      now: () => '2026-08-05T13:00:00.000Z',
    });

    // The worker woken by expiry yields again, which re-arms the watch. The
    // new deadline is the new wait's, and the expiry event belongs to the
    // wait nobody is in any more.
    await withDatabase(undefined, env, async (db) => {
      await new WatchStore(db).set({
        node: 'owner/repo#1',
        intervalSeconds: 900,
        at: '2026-08-05T13:05:00.000Z',
        expiresAt: '2026-08-05T19:05:00.000Z',
        snapshot: BASE,
        session: 'S1',
      });
      assert.deepEqual(await new PrEventStore(db).undelivered('S1'), []);
      const due = await new WatchStore(db).due('2026-08-05T14:00:00.000Z', 5);
      assert.equal(due[0]?.expired, false);
    });
  });

  it('polls an expired watch ahead of a flood of never-checked ones', async () => {
    const env = await tempEnv();
    await fixture(env, BASE);

    // Give the expired row a checked_at, which is what sinks it behind every
    // never-checked row under a plain oldest-check order.
    await pollWatches(env, {snapshot: snapshotter(BASE), now: () => LATER});

    await withDatabase(undefined, env, async (db) => {
      for (let n = 2; n <= 13; n += 1) {
        await new PrStore(db).upsertPr({
          id: `owner/repo#${String(n)}`,
          ticket: null,
          origin: 'prompt',
          repo: 'owner/repo',
          prNumber: n,
          url: null,
          branch: null,
          title: `pr ${String(n)}`,
          injected: false,
          priority: null,
          updatedAt: NOW,
        });
        await new WatchStore(db).set({
          node: `owner/repo#${String(n)}`,
          intervalSeconds: 60,
          at: '2026-08-05T12:50:00.000Z',
          expiresAt: '2026-08-05T18:50:00.000Z',
          snapshot: BASE,
          session: 'S1',
        });
      }
    });

    // One pass reads at most ten watches. More than that arrive unchecked, so
    // an expiry that waits its turn is an expiry that never happens.
    const {fired} = await pollWatches(env, {
      snapshot: snapshotter(BASE),
      now: () => '2026-08-05T13:00:00.000Z',
    });

    assert.deepEqual(fired, ['owner/repo#1']);
  });

  it('still expires a watch that polls kept finding unchanged', async () => {
    const env = await tempEnv();
    await fixture(env, BASE);

    // A quiet PR is polled many times before its deadline. None of those polls
    // may move the deadline, or the item it exists to rescue never reaches it.
    for (const at of [LATER, '2026-08-05T12:45:00.000Z']) {
      const {fired} = await pollWatches(env, {
        snapshot: snapshotter(BASE),
        now: () => at,
      });
      assert.deepEqual(fired, []);
    }

    const {fired} = await pollWatches(env, {
      snapshot: () => {
        throw new Error('must not be called for an expired watch');
      },
      // The expiry the fixture armed, unchanged by the polls in between.
      now: () => '2026-08-05T13:00:00.000Z',
    });

    assert.deepEqual(fired, ['owner/repo#1']);
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
