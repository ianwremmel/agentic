import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {hostname} from 'node:os';
import {describe, it} from 'node:test';

import {runCommand, tempEnv} from '../../lib/command/test-support.mts';
import {nowIso, withDatabase} from '../../lib/db/index.mts';
import {processStartIso} from '../../lib/liveness/index.mts';
import {SessionStore} from '../../lib/stores/index.mts';
import {Command as Ack} from './ack.mts';
import {Command as Status} from './status.mts';

/**
 * Register a row this test process can vouch for — the status command
 * verifies the registered pid and start time against a real process.
 */
async function withServer(env: NodeJS.ProcessEnv, id = 'REG-1'): Promise<void> {
  await withDatabase(undefined, env, async (db) =>
    new SessionStore(db).register({
      id,
      host: hostname(),
      pid: process.pid,
      claudeSessionId: env.CLAUDE_CODE_SESSION_ID ?? null,
      startedAt: processStartIso(),
      heartbeatAt: nowIso(),
    })
  );
}

/** A pid that certainly held a process that has since exited. */
async function deadPid(): Promise<number> {
  const child = spawn('true', {stdio: 'ignore'});
  const pid = child.pid;
  assert.ok(pid !== undefined);
  await new Promise((resolve) => child.once('exit', resolve));
  return pid;
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
    await withServer(env, 'REG-2');

    assert.equal(
      await runCommand(new Status(), {}, env),
      'inactive ambiguous-session\n'
    );
  });

  it('rules a dead server process out instead of reporting ambiguity', async () => {
    const env = {...(await tempEnv()), CLAUDE_CODE_SESSION_ID: 'claude-1'};
    await withServer(env);

    // A replaced server: killed without cleanup, so its row still carries a
    // fresh heartbeat — but its pid is gone.
    await withDatabase(undefined, env, async (db) =>
      new SessionStore(db).register({
        id: 'REG-DEAD',
        host: hostname(),
        pid: await deadPid(),
        claudeSessionId: 'claude-1',
        startedAt: nowIso(),
        heartbeatAt: nowIso(),
      })
    );

    assert.equal(
      await runCommand(new Status(), {}, env),
      'inactive awaiting-ack\n'
    );
  });

  it('refuses --server on a row whose process is dead', async () => {
    const env = {...(await tempEnv()), CLAUDE_CODE_SESSION_ID: 'claude-1'};
    await withDatabase(undefined, env, async (db) =>
      new SessionStore(db).register({
        id: 'REG-DEAD',
        host: hostname(),
        pid: await deadPid(),
        claudeSessionId: 'claude-1',
        startedAt: nowIso(),
        heartbeatAt: nowIso(),
      })
    );
    await runCommand(new Ack(), {server: 'REG-DEAD'}, env);

    assert.equal(
      await runCommand(new Status(), {server: 'REG-DEAD'}, env),
      'inactive no-server-for-session\n'
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
