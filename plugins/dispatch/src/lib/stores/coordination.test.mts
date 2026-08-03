import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {Database} from '../db/database.mts';
import {DataError} from '../errors/index.mts';
import {CoordinationStore} from './coordination.mts';

async function fresh(): Promise<{db: Database; store: CoordinationStore}> {
  const db = await Database.open(':memory:');
  db.run("INSERT INTO node (external_id, kind) VALUES ('T1','ticket')");
  db.run(
    "INSERT INTO session (id, started_at, heartbeat_at) VALUES ('s1','2026-07-31T00:00:00Z','2026-07-31T00:00:00Z')"
  );
  db.run(
    "INSERT INTO session (id, started_at, heartbeat_at) VALUES ('s2','2026-07-31T00:00:00Z','2026-07-31T00:00:00Z')"
  );
  return {db, store: new CoordinationStore(db)};
}

describe('CoordinationStore claims', () => {
  it('claims a free node, refreshes its own, refuses another session', async () => {
    const {db, store} = await fresh();
    const at = '2026-07-31T00:00:00Z';
    assert.equal(
      (await store.claim({node: 'T1', session: 's1', claimedAt: at})).outcome,
      'claimed'
    );
    assert.equal(
      (await store.claim({node: 'T1', session: 's1', claimedAt: at})).outcome,
      'refreshed'
    );
    const held = await store.claim({node: 'T1', session: 's2', claimedAt: at});
    assert.equal(held.outcome, 'held');
    assert.equal(held.heldBy, 's1');
    await db.close();
  });

  it('rejects a malformed claimedAt', async () => {
    const {db, store} = await fresh();
    await assert.rejects(
      store.claim({node: 'T1', session: 's1', claimedAt: 'not-a-time'}),
      (err: unknown) => err instanceof DataError
    );
    await db.close();
  });

  it('reports an unknown node', async () => {
    const {db, store} = await fresh();
    assert.equal(
      (
        await store.claim({
          node: 'NOPE',
          session: 's1',
          claimedAt: '2026-07-31T00:00:00Z',
        })
      ).outcome,
      'unknown-node'
    );
    await db.close();
  });

  it('release refuses another session and is idempotent', async () => {
    const {db, store} = await fresh();
    const at = '2026-07-31T00:00:00Z';
    await store.claim({node: 'T1', session: 's1', claimedAt: at});
    assert.equal(await store.release('T1', 's2'), 'not-yours');
    assert.equal(await store.release('T1', 's1'), 'released');
    assert.equal(await store.release('T1', 's1'), 'absent');
    await db.close();
  });

  it('lists all claims with their session and actor', async () => {
    const {db, store} = await fresh();
    db.run("INSERT INTO node (external_id, kind) VALUES ('T2','ticket')");
    const at = '2026-07-31T00:00:00Z';
    await store.claim({node: 'T1', session: 's1', actor: 'c1', claimedAt: at});
    await store.claim({node: 'T2', session: 's2', claimedAt: at});
    const rows = [...(await store.claims())].sort((a, b) =>
      a.node.localeCompare(b.node)
    );
    assert.deepEqual(rows, [
      {node: 'T1', session: 's1', actor: 'c1'},
      {node: 'T2', session: 's2', actor: null},
    ]);
    await db.close();
  });
});

describe('CoordinationStore slots', () => {
  it('bounds acquisition and is idempotent per actor', async () => {
    const {db, store} = await fresh();
    const at = '2026-07-31T00:00:00Z';
    assert.equal(
      await store.acquireSlot({
        session: 's1',
        actor: 'w1',
        max: 1,
        acquiredAt: at,
      }),
      'acquired'
    );
    assert.equal(
      await store.acquireSlot({
        session: 's1',
        actor: 'w1',
        max: 1,
        acquiredAt: at,
      }),
      'refreshed'
    );
    assert.equal(await store.slotCount(), 1);
    assert.equal(
      await store.acquireSlot({
        session: 's2',
        actor: 'w2',
        max: 1,
        acquiredAt: at,
      }),
      'full'
    );
    assert.equal(await store.releaseSlot('s1', 'w1'), true);
    assert.equal(
      await store.acquireSlot({
        session: 's2',
        actor: 'w2',
        max: 1,
        acquiredAt: at,
      }),
      'acquired'
    );
    await db.close();
  });

  it('rejects a malformed acquiredAt', async () => {
    const {db, store} = await fresh();
    await assert.rejects(
      store.acquireSlot({
        session: 's1',
        actor: 'w1',
        max: 1,
        acquiredAt: 'not-a-time',
      }),
      (err: unknown) => err instanceof DataError
    );
    await db.close();
  });
});

describe('CoordinationStore recordOutcome', () => {
  it("writes the outcome and releases the holder's claim and slot", async () => {
    const {db, store} = await fresh();
    const at = '2026-07-31T00:00:00Z';
    await store.claim({node: 'T1', session: 's1', actor: 'c1', claimedAt: at});
    await store.acquireSlot({
      session: 's1',
      actor: 'c1',
      max: 4,
      acquiredAt: at,
    });
    await store.recordOutcome(
      {
        node: 'T1',
        outcome: 'delivered',
        retryable: null,
        detail: null,
        recordedAt: at,
      },
      {session: 's1', actor: 'c1'}
    );
    assert.equal((await store.getOutcome('T1'))?.outcome, 'delivered');
    assert.equal(Number(db.get('SELECT COUNT(*) AS n FROM claim')?.n), 0);
    assert.equal(await store.slotCount(), 0);
    await db.close();
  });

  it('rejects retryable on a non-failed outcome', async () => {
    const {db, store} = await fresh();
    await assert.rejects(
      store.recordOutcome(
        {
          node: 'T1',
          outcome: 'verified',
          retryable: true,
          detail: null,
          recordedAt: '2026-07-31T00:00:00Z',
        },
        {session: 's1'}
      ),
      (err: unknown) => err instanceof DataError
    );
    await db.close();
  });

  it('rejects a malformed recordedAt', async () => {
    const {db, store} = await fresh();
    await assert.rejects(
      store.recordOutcome(
        {
          node: 'T1',
          outcome: 'delivered',
          retryable: null,
          detail: null,
          recordedAt: '07/31/2026',
        },
        {session: 's1'}
      ),
      (err: unknown) => err instanceof DataError
    );
    await db.close();
  });
});
