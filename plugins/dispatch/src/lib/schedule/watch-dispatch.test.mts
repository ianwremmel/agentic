import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {tempEnv} from '../command/test-support.mts';
import {nowIso, withDatabase} from '../db/index.mts';
import type {Database} from '../db/database.mts';
import {dispatchQueue} from '../graph/index.mts';
import {PrStore, SessionStore, WatchStore} from '../stores/index.mts';
import {Scheduler} from './scheduler.mts';

async function seed(env: NodeJS.ProcessEnv): Promise<void> {
  await withDatabase(undefined, env, async (db) => {
    const at = nowIso();
    const sessions = new SessionStore(db);
    await sessions.register({id: 'srv-1', startedAt: at, heartbeatAt: at});
    await sessions.ack('srv-1', null, at);
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
  });
}

async function watchThenFire(db: Database): Promise<void> {
  const watches = new WatchStore(db);
  await watches.set({
    node: 'o/r#1',
    reason: 'review',
    intervalSeconds: 300,
    at: nowIso(),
    expiresAt: '2199-01-01T00:00:00Z',
    fingerprint: 'a',
  });
  const [due] = await watches.due(nowIso(), 10);
  assert.ok(due);
  await watches.observe('o/r#1', 'b', nowIso(), due.createdAt);
}

describe('watch and the dispatch queue', () => {
  it('a watching item is never queued; a fired one re-serves as resume', async () => {
    const env = await tempEnv();
    await seed(env);
    await withDatabase(undefined, env, async (db) => {
      const watches = new WatchStore(db);
      await watches.set({
        node: 'o/r#1',
        reason: 'review',
        intervalSeconds: 300,
        at: nowIso(),
        expiresAt: '2199-01-01T00:00:00Z',
        fingerprint: 'a',
      });

      assert.equal((await dispatchQueue(db, {})).length, 0);

      const [due] = await watches.due(nowIso(), 10);
      assert.ok(due);
      await watches.observe('o/r#1', 'b', nowIso(), due.createdAt);
      const [entry] = await dispatchQueue(db, {});
      assert.ok(entry);
      assert.equal(entry.entry.item.id, 'o/r#1');
      assert.equal(entry.pass, 'resume');
    });
  });

  it('a fired watch survives its dispatch, so a crashed resume still resumes', async () => {
    const env = await tempEnv();
    await seed(env);
    await withDatabase(undefined, env, async (db) => {
      await watchThenFire(db);

      const {orders} = await new Scheduler(db, {session: 'srv-1'}).tick(
        nowIso()
      );
      const pr = orders.find((order) => order.kind === 'dispatch_pr');
      assert.ok(pr);
      assert.equal(pr.meta.pass, 'resume');
      // The row is not consumed by dispatch — only an outcome or a fresh
      // watch removes it — so a worker that dies claimless re-queues as
      // resume, not as fresh work.
      assert.deepEqual(await new WatchStore(db).get('o/r#1'), {
        reason: 'review',
        state: 'fired',
      });
    });
  });
});
