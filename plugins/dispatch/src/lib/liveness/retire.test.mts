import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {Database} from '../db/database.mts';
import {SessionStore} from '../stores/session.mts';
import {retireNonLive} from './retire.mts';

const NOW = '2026-08-04T12:00:00.000Z';
const HOST = 'this-host';

async function seeded(): Promise<{db: Database; store: SessionStore}> {
  const db = await Database.open(':memory:');
  return {db, store: new SessionStore(db)};
}

function register(
  store: SessionStore,
  id: string,
  overrides?: {
    claudeSessionId?: string;
    heartbeatAt?: string;
    host?: string;
    pid?: number;
  }
): Promise<void> {
  return store.register({
    id,
    host: overrides?.host ?? HOST,
    pid: overrides?.pid ?? 100,
    claudeSessionId: overrides?.claudeSessionId ?? 'claude-1',
    startedAt: NOW,
    heartbeatAt: overrides?.heartbeatAt ?? NOW,
  });
}

describe('retireNonLive', () => {
  it('retires a heartbeat-fresh row whose process is gone, cascading its claims', async () => {
    const {db, store} = await seeded();
    await register(store, 'own');
    await register(store, 'dead');
    db.run("INSERT INTO node (external_id, kind) VALUES ('T1','ticket')");
    const nid = Number(
      db.get("SELECT id FROM node WHERE external_id='T1'")?.id
    );
    db.run(
      "INSERT INTO claim (node_id, session_id, claimed_at) VALUES (?, 'dead', ?)",
      [nid, NOW]
    );

    const retired = await retireNonLive(db, {
      claudeSessionId: 'claude-1',
      keep: 'own',
      now: NOW,
      staleAfterSeconds: 300,
      host: HOST,
      probe: () => Promise.resolve('absent' as const),
    });

    assert.equal(retired, 1);
    assert.equal(await store.getSession('dead'), null);
    assert.ok(await store.getSession('own'));
    assert.equal(Number(db.get('SELECT COUNT(*) AS n FROM claim')?.n), 0);
    await db.close();
  });

  it('retires a row whose pid was reused by a different process', async () => {
    const {db, store} = await seeded();
    await register(store, 'own');
    await register(store, 'reused');

    const retired = await retireNonLive(db, {
      claudeSessionId: 'claude-1',
      keep: 'own',
      now: NOW,
      staleAfterSeconds: 300,
      host: HOST,
      probe: () => Promise.resolve(Date.parse(NOW) + 3_600_000),
    });

    assert.equal(retired, 1);
    assert.equal(await store.getSession('reused'), null);
    await db.close();
  });

  it('keeps a row whose registration merely lagged its process start', async () => {
    const {db, store} = await seeded();
    await register(store, 'own');
    await register(store, 'laggard');

    const retired = await retireNonLive(db, {
      claudeSessionId: 'claude-1',
      keep: 'own',
      now: NOW,
      staleAfterSeconds: 300,
      host: HOST,
      // The probed start is well before the registered instant — delayed
      // registration, or a row written by an older plugin version that
      // recorded registration time. A reused pid can only start later, so
      // this proves nothing about death.
      probe: () => Promise.resolve(Date.parse(NOW) - 3_600_000),
    });

    assert.equal(retired, 0);
    assert.ok(await store.getSession('laggard'));
    await db.close();
  });

  it('keeps a genuinely live rival rather than resolving ambiguity by recency', async () => {
    const {db, store} = await seeded();
    await register(store, 'own');
    await register(store, 'rival');

    const retired = await retireNonLive(db, {
      claudeSessionId: 'claude-1',
      keep: 'own',
      now: NOW,
      staleAfterSeconds: 300,
      host: HOST,
      probe: () => Promise.resolve(Date.parse(NOW) + 500),
    });

    assert.equal(retired, 0);
    assert.ok(await store.getSession('rival'));
    await db.close();
  });

  it('retires a stale-heartbeat row without consulting the process probe', async () => {
    const {db, store} = await seeded();
    await register(store, 'own');
    await register(store, 'quiet', {heartbeatAt: '2026-08-04T11:00:00.000Z'});

    const retired = await retireNonLive(db, {
      claudeSessionId: 'claude-1',
      keep: 'own',
      now: NOW,
      staleAfterSeconds: 300,
      host: HOST,
      probe: () => {
        throw new Error('staleness alone is proof; must not probe');
      },
    });

    assert.equal(retired, 1);
    assert.equal(await store.getSession('quiet'), null);
    await db.close();
  });

  it('never retires what it cannot disprove', async () => {
    const {db, store} = await seeded();
    await register(store, 'own');
    await register(store, 'elsewhere', {host: 'other-host'});
    await register(store, 'unprobeable');

    const retired = await retireNonLive(db, {
      claudeSessionId: 'claude-1',
      keep: 'own',
      now: NOW,
      staleAfterSeconds: 300,
      host: HOST,
      // The probe fails outright — ps broken — which proves nothing.
      probe: () => Promise.resolve('unknown' as const),
    });

    assert.equal(retired, 0);
    assert.ok(await store.getSession('elsewhere'));
    assert.ok(await store.getSession('unprobeable'));
    await db.close();
  });

  it("never touches another session's rows or the keep row", async () => {
    const {db, store} = await seeded();
    await register(store, 'own');
    await register(store, 'other', {claudeSessionId: 'claude-2'});

    const retired = await retireNonLive(db, {
      claudeSessionId: 'claude-1',
      keep: 'own',
      now: NOW,
      staleAfterSeconds: 300,
      host: HOST,
      probe: () => Promise.resolve('absent' as const),
    });

    assert.equal(retired, 0);
    assert.ok(await store.getSession('own'));
    assert.ok(await store.getSession('other'));
    await db.close();
  });
});
