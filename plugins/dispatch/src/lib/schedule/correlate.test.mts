import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {hostname} from 'node:os';
import {describe, it} from 'node:test';

import {Database} from '../db/database.mts';
import {nowIso} from '../db/time.mts';
import {DataError} from '../errors/index.mts';
import {processStartIso} from '../liveness/index.mts';
import {SessionStore} from '../stores/session.mts';
import {correlateSession, resolveSession} from './correlate.mts';

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

describe('correlateSession', () => {
  it('returns null when no live server rides the caller', async () => {
    const db = await Database.open(':memory:');
    // An operator at a terminal: there is no claim of theirs to release, and
    // the write they came to make must still go through.
    assert.equal(await correlateSession(db, ENV, undefined), null);
    assert.equal(await correlateSession(db, {}, undefined), null);
    await db.close();
  });

  it('refuses to guess between two live servers on one session id', async () => {
    const db = await Database.open(':memory:');
    const sessions = new SessionStore(db);
    for (const id of ['REG-1', 'REG-2']) {
      await sessions.register({
        id,
        host: hostname(),
        pid: process.pid,
        claudeSessionId: 'claude-1',
        startedAt: processStartIso(),
        heartbeatAt: nowIso(),
      });
    }
    // Falling back to "no session" here would silently release nothing and
    // strand the real claim's capacity; the caller must name the server.
    await assert.rejects(
      correlateSession(db, ENV, undefined),
      (err: unknown) =>
        err instanceof DataError && err.message.includes('REG-1, REG-2')
    );
    await db.close();
  });

  it('takes an explicit id over any correlation', async () => {
    const db = await Database.open(':memory:');
    assert.equal(await correlateSession(db, ENV, 'REG-9'), 'REG-9');
    await db.close();
  });
});
