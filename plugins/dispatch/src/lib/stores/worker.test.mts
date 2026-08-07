import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {Database} from '../db/database.mts';
import {CoordinationStore} from './coordination.mts';
import {WorkerStore} from './worker.mts';

const NOW = '2026-08-07T12:00:00.000Z';

async function fixture(): Promise<Database> {
  const db = await Database.open(':memory:');
  db.run("INSERT INTO node (external_id, kind) VALUES ('T1','ticket')");
  db.run(
    "INSERT INTO session (id, started_at, heartbeat_at) VALUES ('S1', ?, ?), ('S2', ?, ?)",
    [NOW, NOW, NOW, NOW]
  );
  return db;
}

describe('WorkerStore', () => {
  it('records where a node’s worker can be reached, per session', async () => {
    const db = await fixture();
    const store = new WorkerStore(db);
    await store.set({
      node: 'T1',
      session: 'S1',
      agentRef: 'agent-abc',
      at: NOW,
    });
    assert.equal(await store.refFor('T1', 'S1'), 'agent-abc');
    // Another session cannot address this worker: only the launcher holds
    // the ref that can actually reach it.
    assert.equal(await store.refFor('T1', 'S2'), null);
    await db.close();
  });

  it('is cleared by the outcome, in the same transaction', async () => {
    const db = await fixture();
    const coordination = new CoordinationStore(db);
    const store = new WorkerStore(db);
    await coordination.claim({node: 'T1', session: 'S1', claimedAt: NOW});
    await store.set({
      node: 'T1',
      session: 'S1',
      agentRef: 'agent-abc',
      at: NOW,
    });
    await coordination.recordOutcome(
      {
        node: 'T1',
        outcome: 'delivered',
        retryable: null,
        detail: null,
        recordedAt: NOW,
      },
      {session: 'S1'}
    );
    // A concluded node has no one to wake; an event for it must fall through
    // to the scheduler, not route to a finished agent.
    assert.equal(await store.refFor('T1', 'S1'), null);
    await db.close();
  });

  it('cascades with its session', async () => {
    const db = await fixture();
    const store = new WorkerStore(db);
    await store.set({
      node: 'T1',
      session: 'S1',
      agentRef: 'agent-abc',
      at: NOW,
    });
    db.run("DELETE FROM session WHERE id = 'S1'");
    assert.equal(await store.refFor('T1', 'S1'), null);
    await db.close();
  });

  it('a relaunch replaces the address', async () => {
    const db = await fixture();
    const store = new WorkerStore(db);
    await store.set({
      node: 'T1',
      session: 'S1',
      agentRef: 'agent-old',
      at: NOW,
    });
    await store.set({
      node: 'T1',
      session: 'S1',
      agentRef: 'agent-new',
      at: NOW,
    });
    assert.equal(await store.refFor('T1', 'S1'), 'agent-new');
    await db.close();
  });
});
