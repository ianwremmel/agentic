import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {Database} from '../db/database.mts';
import {SessionStore} from './session.mts';

async function fresh(): Promise<{db: Database; store: SessionStore}> {
  const db = await Database.open(':memory:');
  return {db, store: new SessionStore(db)};
}

describe('SessionStore', () => {
  it('registers and reads a session', async () => {
    const {db, store} = await fresh();
    await store.register({
      id: 's1',
      host: 'mac',
      pid: 42,
      startedAt: '2026-07-31T00:00:00.000Z',
      heartbeatAt: '2026-07-31T00:00:00.000Z',
    });
    assert.equal((await store.getSession('s1'))?.host, 'mac');
    await db.close();
  });

  it("close cascades the session's claims and slots", async () => {
    const {db, store} = await fresh();
    await store.register({
      id: 's1',
      startedAt: '2026-07-31T00:00:00.000Z',
      heartbeatAt: '2026-07-31T00:00:00.000Z',
    });
    db.run("INSERT INTO node (external_id, kind) VALUES ('T1','ticket')");
    const nid = Number(
      db.get("SELECT id FROM node WHERE external_id='T1'")?.id
    );
    db.run(
      "INSERT INTO claim (node_id, session_id, claimed_at) VALUES (?, 's1', '2026-07-31T00:00:00Z')",
      [nid]
    );
    db.run(
      "INSERT INTO slot (session_id, actor, acquired_at) VALUES ('s1', 'w1', '2026-07-31T00:00:00Z')"
    );
    assert.equal(await store.close('s1'), true);
    assert.equal(Number(db.get('SELECT COUNT(*) AS n FROM claim')?.n), 0);
    assert.equal(Number(db.get('SELECT COUNT(*) AS n FROM slot')?.n), 0);
    await db.close();
  });

  it('sweepStale removes only sessions past the window', async () => {
    const {db, store} = await fresh();
    await store.register({
      id: 'old',
      startedAt: '2026-07-31T00:00:00.000Z',
      heartbeatAt: '2026-07-31T00:00:00.000Z',
    });
    await store.register({
      id: 'fresh',
      startedAt: '2026-07-31T00:09:30.000Z',
      heartbeatAt: '2026-07-31T00:09:30.000Z',
    });
    // 10-minute window, "now" is 00:10:00 → 'old' is 600s stale, 'fresh' is 30s.
    const removed = await store.sweepStale('2026-07-31T00:10:00.000Z', 300);
    assert.equal(removed, 1);
    assert.equal(await store.getSession('old'), null);
    assert.ok(await store.getSession('fresh'));
    await db.close();
  });
});
