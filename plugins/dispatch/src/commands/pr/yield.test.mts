import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {runCommand, tempEnv} from '../../lib/command/test-support.mts';
import {withDatabase} from '../../lib/db/index.mts';
import {DataError} from '../../lib/errors/index.mts';
import {
  CoordinationStore,
  PrStore,
  SessionStore,
  WatchStore,
} from '../../lib/stores/index.mts';
import {Command} from './yield.mts';

const NOW = '2026-08-05T12:00:00.000Z';

async function fixture(env: NodeJS.ProcessEnv, claimBy: string | null) {
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
    const sessions = new SessionStore(db);
    for (const id of ['S1', 'S2']) {
      await sessions.register({id, startedAt: NOW, heartbeatAt: NOW});
    }
    if (claimBy !== null) {
      await new CoordinationStore(db).claim({
        node: 'owner/repo#1',
        session: claimBy,
        claimedAt: NOW,
      });
    }
  });
}

describe('pr yield', () => {
  it('refuses when the claim belongs to another session', async () => {
    const env = await tempEnv();
    await fixture(env, 'S2');

    // This worker was superseded. Arming would hide S2's live claim behind a
    // watching row, and a watching item is never queued — so S2's work would
    // read as waiting while S2 is still running it.
    await assert.rejects(
      runCommand(new Command(), {id: 'owner/repo#1', session: 'S1'}, env),
      (err: unknown) => err instanceof DataError
    );

    await withDatabase(undefined, env, async (db) => {
      assert.equal(await new WatchStore(db).get('owner/repo#1'), null);
      assert.deepEqual(await new CoordinationStore(db).claims(), [
        {node: 'owner/repo#1', session: 'S2', actor: null},
      ]);
    });
  });

  it('releases the claim and arms the watch together', async () => {
    const env = await tempEnv();
    await fixture(env, 'S1');

    await runCommand(new Command(), {id: 'owner/repo#1', session: 'S1'}, env);

    await withDatabase(undefined, env, async (db) => {
      // Neither half may be visible without the other: between a released
      // claim and an installed watch the item is free for another server.
      assert.deepEqual(await new CoordinationStore(db).claims(), []);
      assert.equal(
        (await new WatchStore(db).get('owner/repo#1'))?.state,
        'watching'
      );
    });
  });
});
