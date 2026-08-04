import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {hostname} from 'node:os';
import {describe, it} from 'node:test';

import {Database} from '../db/database.mts';
import {nowIso} from '../db/time.mts';
import {DataError} from '../errors/index.mts';
import {processStartIso} from '../liveness/index.mts';
import {SessionStore} from '../stores/session.mts';
import {resolveSession} from './correlate.mts';

const ENV = {CLAUDE_CODE_SESSION_ID: 'claude-1'};

/** A pid that certainly held a process that has since exited. */
async function deadPid(): Promise<number> {
  const child = spawn('true', {stdio: 'ignore'});
  const pid = child.pid;
  assert.ok(pid !== undefined);
  await new Promise((resolve) => child.once('exit', resolve));
  return pid;
}

describe('resolveSession', () => {
  it('returns an explicit id without correlating', async () => {
    const db = await Database.open(':memory:');
    assert.equal(await resolveSession(db, ENV, 'REG-9'), 'REG-9');
    await db.close();
  });

  it("resolves the caller's one live server", async () => {
    const db = await Database.open(':memory:');
    await new SessionStore(db).register({
      id: 'REG-1',
      host: hostname(),
      pid: process.pid,
      claudeSessionId: 'claude-1',
      startedAt: processStartIso(),
      heartbeatAt: nowIso(),
    });
    assert.equal(await resolveSession(db, ENV, undefined), 'REG-1');
    await db.close();
  });

  it('refuses to resolve to a row whose server process is dead', async () => {
    const db = await Database.open(':memory:');
    await new SessionStore(db).register({
      id: 'REG-1',
      host: hostname(),
      pid: await deadPid(),
      claudeSessionId: 'claude-1',
      startedAt: nowIso(),
      heartbeatAt: nowIso(),
    });
    await assert.rejects(
      resolveSession(db, ENV, undefined),
      (err: unknown) => err instanceof DataError
    );
    await db.close();
  });
});
