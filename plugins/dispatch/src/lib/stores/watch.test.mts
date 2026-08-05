import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {tempEnv} from '../command/test-support.mts';
import {withDatabase} from '../db/index.mts';
import type {Database} from '../db/database.mts';
import {CoordinationStore, PrStore, WatchStore} from './index.mts';

const AT = '2026-08-05T00:00:00Z';
const EXPIRES = '2026-08-05T06:00:00Z';

async function seedPr(db: Database, id = 'o/r#1'): Promise<void> {
  await new PrStore(db).upsertPr({
    id,
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

function watching(overrides: Partial<Parameters<WatchStore['set']>[0]> = {}) {
  return {
    node: 'o/r#1',
    reason: 'ci' as const,
    intervalSeconds: 60,
    at: AT,
    expiresAt: EXPIRES,
    fingerprint: null,
    ...overrides,
  };
}

describe('WatchStore', () => {
  it('a baseline armed at set time fires on the first differing poll', async () => {
    const env = await tempEnv();
    await withDatabase(undefined, env, async (db) => {
      await seedPr(db);
      const watches = new WatchStore(db);
      await watches.set(watching({fingerprint: 'armed'}));
      assert.equal(
        await watches.observe('o/r#1', 'armed', AT, AT),
        'unchanged'
      );
      assert.equal(await watches.observe('o/r#1', 'changed', AT, AT), 'fired');
    });
  });

  it('without a baseline, primes first and fires on the next change', async () => {
    const env = await tempEnv();
    await withDatabase(undefined, env, async (db) => {
      await seedPr(db);
      const watches = new WatchStore(db);
      await watches.set(watching());
      assert.equal(await watches.observe('o/r#1', 'a', AT, AT), 'primed');
      assert.equal(await watches.observe('o/r#1', 'a', AT, AT), 'unchanged');
      assert.equal(await watches.observe('o/r#1', 'b', AT, AT), 'fired');
    });
  });

  it('an observation for a replaced watch is stale and changes nothing', async () => {
    const env = await tempEnv();
    await withDatabase(undefined, env, async (db) => {
      await seedPr(db);
      const watches = new WatchStore(db);
      await watches.set(watching({fingerprint: 'old'}));
      const later = '2026-08-05T01:00:00Z';
      await watches.set(watching({fingerprint: 'new', at: later}));
      // The poll started against the AT generation; its result must not
      // touch the replacement.
      assert.equal(
        await watches.observe('o/r#1', 'changed', later, AT),
        'stale'
      );
      assert.deepEqual(await watches.get('o/r#1'), {
        reason: 'ci',
        state: 'watching',
      });
    });
  });

  it('is due when never checked, past its interval, or expired', async () => {
    const env = await tempEnv();
    await withDatabase(undefined, env, async (db) => {
      await seedPr(db);
      const watches = new WatchStore(db);
      await watches.set(watching({reason: 'review', intervalSeconds: 300}));

      const [first] = await watches.due(AT, 10);
      assert.ok(first);
      assert.equal(first.expired, false);
      await watches.observe('o/r#1', 'fp', AT, first.createdAt);
      assert.equal((await watches.due('2026-08-05T00:04:00Z', 10)).length, 0);
      assert.equal((await watches.due('2026-08-05T00:05:00Z', 10)).length, 1);

      // Past expires_at the row is due regardless of interval, marked so.
      await watches.observe(
        'o/r#1',
        'fp',
        '2026-08-05T05:59:59Z',
        first.createdAt
      );
      const [expired] = await watches.due('2026-08-05T06:00:00Z', 10);
      assert.ok(expired);
      assert.equal(expired.expired, true);
      assert.equal(
        await watches.fire('o/r#1', EXPIRES, expired.createdAt),
        'fired'
      );
    });
  });

  it('a touch for a replaced watch does not delay the replacement', async () => {
    const env = await tempEnv();
    await withDatabase(undefined, env, async (db) => {
      await seedPr(db);
      const watches = new WatchStore(db);
      await watches.set(watching({fingerprint: 'old'}));
      const later = '2026-08-05T01:00:00Z';
      await watches.set(watching({fingerprint: 'new', at: later}));
      // A failed poll against the AT generation lands after the replacement:
      // the new row must still be due on its own schedule.
      await watches.touch('o/r#1', '2026-08-05T01:00:30Z', AT);
      assert.equal((await watches.due(later, 10)).length, 1);
    });
  });

  it('recording an outcome removes the watch', async () => {
    const env = await tempEnv();
    await withDatabase(undefined, env, async (db) => {
      await seedPr(db);
      const watches = new WatchStore(db);
      await watches.set(watching());
      await new CoordinationStore(db).recordOutcome(
        {
          node: 'o/r#1',
          outcome: 'delivered',
          retryable: null,
          detail: null,
          recordedAt: AT,
        },
        {session: 'srv-1'}
      );
      assert.equal(await watches.get('o/r#1'), null);
    });
  });
});
