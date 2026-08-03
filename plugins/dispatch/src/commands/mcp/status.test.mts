import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {runCommand, tempEnv} from '../../lib/command/test-support.mts';
import {nowIso, withDatabase} from '../../lib/db/index.mts';
import {SessionStore} from '../../lib/stores/index.mts';
import {Command as Ack} from './ack.mts';
import {Command as Status} from './status.mts';

async function withServer(env: NodeJS.ProcessEnv): Promise<void> {
  await withDatabase(undefined, env, async (db) =>
    new SessionStore(db).register({
      id: 'REG-1',
      claudeSessionId: env.CLAUDE_CODE_SESSION_ID ?? null,
      startedAt: nowIso(),
      heartbeatAt: nowIso(),
    })
  );
}

describe('mcp status', () => {
  it('fails closed without a session id', async () => {
    const env = await tempEnv();
    const out = await runCommand(new Status(), {}, env);
    assert.equal(out, 'inactive no-session-id\n');
  });

  it('reports no server, then awaiting-ack, then active as the handshake lands', async () => {
    const env = {...(await tempEnv()), CLAUDE_CODE_SESSION_ID: 'claude-1'};

    assert.equal(
      await runCommand(new Status(), {}, env),
      'inactive no-server-for-session\n'
    );

    await withServer(env);
    assert.equal(
      await runCommand(new Status(), {}, env),
      'inactive awaiting-ack\n'
    );

    await runCommand(new Ack(), {server: 'REG-1'}, env);
    assert.equal(await runCommand(new Status(), {}, env), 'active REG-1\n');
  });

  it('reports ambiguous-session rather than picking a row', async () => {
    const env = {...(await tempEnv()), CLAUDE_CODE_SESSION_ID: 'claude-1'};
    await withServer(env);
    await withDatabase(undefined, env, async (db) =>
      new SessionStore(db).register({
        id: 'REG-2',
        claudeSessionId: 'claude-1',
        startedAt: nowIso(),
        heartbeatAt: nowIso(),
      })
    );

    assert.equal(
      await runCommand(new Status(), {}, env),
      'inactive ambiguous-session\n'
    );
  });

  it("refuses to answer for another session's server via --server", async () => {
    const env = {...(await tempEnv()), CLAUDE_CODE_SESSION_ID: 'claude-2'};
    await withDatabase(undefined, env, async (db) =>
      new SessionStore(db).register({
        id: 'REG-1',
        claudeSessionId: 'claude-1',
        startedAt: nowIso(),
        heartbeatAt: nowIso(),
      })
    );

    assert.equal(
      await runCommand(new Status(), {server: 'REG-1'}, env),
      'inactive no-server-for-session\n'
    );
  });
});
