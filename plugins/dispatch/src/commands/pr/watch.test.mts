import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {runCommand, tempEnv} from '../../lib/command/test-support.mts';
import {nowIso, withDatabase} from '../../lib/db/index.mts';
import {
  CoordinationStore,
  PrStore,
  SessionStore,
  WatchStore,
} from '../../lib/stores/index.mts';
import {Command} from './watch.mts';

async function seed(
  env: NodeJS.ProcessEnv,
  prNumber: number | null = 7
): Promise<void> {
  await withDatabase(undefined, env, async (db) => {
    const at = nowIso();
    await new SessionStore(db).register({
      id: 'srv-1',
      claudeSessionId: env.CLAUDE_CODE_SESSION_ID ?? null,
      startedAt: at,
      heartbeatAt: at,
    });
    await new PrStore(db).upsertPr({
      id: 'o/r#7',
      ticket: null,
      origin: 'prompt',
      repo: 'o/r',
      prNumber,
      url: null,
      branch: null,
      title: 't',
      injected: false,
      priority: null,
      updatedAt: null,
    });
  });
}

describe('pr watch', () => {
  it('records the watch and releases the caller session claim and slot', async () => {
    const env = {...(await tempEnv()), CLAUDE_CODE_SESSION_ID: 'sess-1'};
    await seed(env);
    await withDatabase(undefined, env, async (db) => {
      const coordination = new CoordinationStore(db);
      await coordination.claim({
        node: 'o/r#7',
        session: 'srv-1',
        claimedAt: nowIso(),
      });
      await coordination.acquireSlot({
        session: 'srv-1',
        actor: 'o/r#7',
        max: 3,
        acquiredAt: nowIso(),
      });
    });

    const out = await runCommand(
      new Command(),
      {id: 'o/r#7', for: 'review'},
      env
    );
    assert.equal(out, 'watch o/r#7 review\n');

    await withDatabase(undefined, env, async (db) => {
      assert.deepEqual(await new WatchStore(db).get('o/r#7'), {
        reason: 'review',
        state: 'watching',
      });
      const coordination = new CoordinationStore(db);
      assert.equal((await coordination.claims()).length, 0);
      assert.equal(await coordination.slotCount(), 0);
    });
  });

  it("never releases another session's claim", async () => {
    const env = {...(await tempEnv()), CLAUDE_CODE_SESSION_ID: 'sess-1'};
    await seed(env);
    await withDatabase(undefined, env, async (db) => {
      const at = nowIso();
      await new SessionStore(db).register({
        id: 'srv-2',
        startedAt: at,
        heartbeatAt: at,
      });
      await new CoordinationStore(db).claim({
        node: 'o/r#7',
        session: 'srv-2',
        claimedAt: at,
      });
    });

    await runCommand(new Command(), {id: 'o/r#7', for: 'ci'}, env);

    await withDatabase(undefined, env, async (db) => {
      const [claim] = await new CoordinationStore(db).claims();
      assert.ok(claim);
      assert.equal(claim.session, 'srv-2');
    });
  });

  it('refuses an item that already concluded', async () => {
    const env = {...(await tempEnv()), CLAUDE_CODE_SESSION_ID: 'sess-1'};
    await seed(env);
    await withDatabase(undefined, env, async (db) => {
      await new CoordinationStore(db).recordOutcome(
        {
          node: 'o/r#7',
          outcome: 'delivered',
          retryable: null,
          detail: null,
          recordedAt: nowIso(),
        },
        {session: 'srv-1'}
      );
    });
    await assert.rejects(
      runCommand(new Command(), {id: 'o/r#7', for: 'ci'}, env),
      /already has an outcome/
    );
  });

  it('refuses an item with no PR to poll', async () => {
    const env = {...(await tempEnv()), CLAUDE_CODE_SESSION_ID: 'sess-1'};
    await seed(env, null);
    await assert.rejects(
      runCommand(new Command(), {id: 'o/r#7', for: 'ci'}, env),
      /no PR to poll/
    );
  });

  it('refuses an unregistered item', async () => {
    const env = {...(await tempEnv()), CLAUDE_CODE_SESSION_ID: 'sess-1'};
    await assert.rejects(
      runCommand(new Command(), {id: 'o/r#9', for: 'ci'}, env),
      /no PR item/
    );
  });
});
