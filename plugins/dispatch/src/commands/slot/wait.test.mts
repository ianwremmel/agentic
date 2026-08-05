import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {setTimeout as sleep} from 'node:timers/promises';

import {runCommand, tempEnv} from '../../lib/command/test-support.mts';
import {nowIso, withDatabase} from '../../lib/db/index.mts';
import {CoordinationStore, SessionStore} from '../../lib/stores/index.mts';
import {Command} from './wait.mts';

async function liveSession(env: NodeJS.ProcessEnv): Promise<void> {
  await withDatabase(undefined, env, async (db) => {
    const at = nowIso();
    await new SessionStore(db).register({
      id: 'srv-1',
      claudeSessionId: env.CLAUDE_CODE_SESSION_ID ?? null,
      startedAt: at,
      heartbeatAt: at,
    });
  });
}

describe('slot wait', () => {
  it('acquires immediately when the ledger has room', async () => {
    const env = {...(await tempEnv()), CLAUDE_CODE_SESSION_ID: 'sess-1'};
    await liveSession(env);
    const out = await runCommand(new Command(), {actor: 'X', max: '1'}, env);
    assert.equal(out, 'slot acquired X\n');
  });

  it('blocks while the ledger is full and acquires once a slot frees', async () => {
    const env = {...(await tempEnv()), CLAUDE_CODE_SESSION_ID: 'sess-1'};
    await liveSession(env);
    await withDatabase(undefined, env, async (db) => {
      await new CoordinationStore(db).acquireSlot({
        session: 'srv-1',
        actor: 'holder',
        max: 1,
        acquiredAt: nowIso(),
      });
    });

    const releaseSoon = (async () => {
      await sleep(300);
      await withDatabase(undefined, env, async (db) => {
        await new CoordinationStore(db).releaseSlot('srv-1', 'holder');
      });
    })();

    const out = await runCommand(
      new Command(),
      {
        actor: 'X',
        max: '1',
        'timeout-seconds': '5',
        'interval-seconds': '0.1',
      },
      env
    );
    await releaseSoon;
    assert.equal(out, 'slot acquired X\n');
  });

  it('fails with a retry hint when the ledger stays full past the timeout', async () => {
    const env = {...(await tempEnv()), CLAUDE_CODE_SESSION_ID: 'sess-1'};
    await liveSession(env);
    await withDatabase(undefined, env, async (db) => {
      await new CoordinationStore(db).acquireSlot({
        session: 'srv-1',
        actor: 'holder',
        max: 1,
        acquiredAt: nowIso(),
      });
    });

    // The interval is far longer than the timeout: the sleep must be capped
    // to the remaining deadline, so the command still fails on time instead
    // of overshooting by a full interval.
    const started = Date.now();
    await assert.rejects(
      runCommand(
        new Command(),
        {
          actor: 'X',
          max: '1',
          'timeout-seconds': '0.3',
          'interval-seconds': '60',
        },
        env
      ),
      /stayed full/
    );
    assert.ok(Date.now() - started < 5_000);
  });

  it('rejects a non-positive interval instead of busy-looping', async () => {
    const env = {...(await tempEnv()), CLAUDE_CODE_SESSION_ID: 'sess-1'};
    await liveSession(env);
    await assert.rejects(
      runCommand(new Command(), {actor: 'X', 'interval-seconds': '0'}, env),
      /--interval-seconds must be positive/
    );
    await assert.rejects(
      runCommand(new Command(), {actor: 'X', 'timeout-seconds': '-1'}, env),
      /--timeout-seconds must be positive/
    );
  });
});
