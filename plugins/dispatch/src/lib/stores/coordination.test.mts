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

describe('CoordinationStore claim capacity', () => {
  it('refuses a fresh claim past the cap inside the transaction', async () => {
    const {db, store} = await fresh();
    db.run("INSERT INTO node (external_id, kind) VALUES ('T2','ticket')");
    const at = '2026-07-31T00:00:00Z';
    assert.equal(
      (await store.claim({node: 'T1', session: 's1', claimedAt: at, max: 1}))
        .outcome,
      'claimed'
    );
    // A second server counted the same free capacity before either claimed;
    // only the transaction can refuse the loser.
    assert.equal(
      (await store.claim({node: 'T2', session: 's2', claimedAt: at, max: 1}))
        .outcome,
      'full'
    );
    await db.close();
  });

  it('never refuses a refresh of a claim this session already holds', async () => {
    const {db, store} = await fresh();
    const at = '2026-07-31T00:00:00Z';
    await store.claim({node: 'T1', session: 's1', claimedAt: at, max: 1});
    // The cap is already met by this very claim; re-claiming it must not
    // strand the worker that holds it.
    assert.equal(
      (await store.claim({node: 'T1', session: 's1', claimedAt: at, max: 0}))
        .outcome,
      'refreshed'
    );
    await db.close();
  });

  it('does not count a dead session\u2019s claim toward the cap', async () => {
    const {db, store} = await fresh();
    db.run("INSERT INTO node (external_id, kind) VALUES ('T2','ticket')");
    await store.claim({
      node: 'T1',
      session: 's1',
      claimedAt: '2026-07-31T00:00:00Z',
      max: 1,
    });
    // s1 stopped heartbeating an hour ago; its claim is not compute in use.
    assert.equal(
      (
        await store.claim({
          node: 'T2',
          session: 's2',
          claimedAt: '2026-07-31T01:00:00Z',
          max: 1,
        })
      ).outcome,
      'claimed'
    );
    await db.close();
  });

  it('bounds nothing when no cap is given', async () => {
    const {db, store} = await fresh();
    db.run("INSERT INTO node (external_id, kind) VALUES ('T2','ticket')");
    const at = '2026-07-31T00:00:00Z';
    await store.claim({node: 'T1', session: 's1', claimedAt: at});
    assert.equal(
      (await store.claim({node: 'T2', session: 's2', claimedAt: at})).outcome,
      'claimed'
    );
    await db.close();
  });
});

describe('CoordinationStore inFlightCount', () => {
  it('counts a claim only while its session heartbeats', async () => {
    const {db, store} = await fresh();
    db.run("INSERT INTO node (external_id, kind) VALUES ('T2','ticket')");
    const at = '2026-07-31T00:00:00Z';
    await store.claim({node: 'T1', session: 's1', claimedAt: at});
    await store.claim({node: 'T2', session: 's2', claimedAt: at});
    assert.equal(
      await store.inFlightCount({now: at, staleAfterSeconds: 300}),
      2
    );

    // s2's heartbeat is now 10 minutes old: its claim is nobody's obligation
    // and must stop consuming an admission.
    const later = '2026-07-31T00:10:00Z';
    db.run("UPDATE session SET heartbeat_at = ? WHERE id = 's1'", [later]);
    assert.equal(
      await store.inFlightCount({now: later, staleAfterSeconds: 300}),
      1
    );
    await db.close();
  });

  it('rejects a malformed now', async () => {
    const {db, store} = await fresh();
    await assert.rejects(
      store.inFlightCount({now: 'not-a-time', staleAfterSeconds: 300}),
      (err: unknown) => err instanceof DataError
    );
    await db.close();
  });
});

describe('CoordinationStore recordOutcome', () => {
  it("writes the outcome and releases the holder's claim", async () => {
    const {db, store} = await fresh();
    const at = '2026-07-31T00:00:00Z';
    await store.claim({node: 'T1', session: 's1', actor: 'c1', claimedAt: at});
    await store.recordOutcome(
      {
        node: 'T1',
        outcome: 'delivered',
        retryable: null,
        detail: null,
        recordedAt: at,
      },
      {session: 's1'}
    );
    assert.equal((await store.getOutcome('T1'))?.outcome, 'delivered');
    assert.equal(Number(db.get('SELECT COUNT(*) AS n FROM claim')?.n), 0);
    await db.close();
  });

  it("leaves another session's claim alone", async () => {
    const {db, store} = await fresh();
    const at = '2026-07-31T00:00:00Z';
    await store.claim({node: 'T1', session: 's1', claimedAt: at});
    await store.recordOutcome(
      {
        node: 'T1',
        outcome: 'delivered',
        retryable: null,
        detail: null,
        recordedAt: at,
      },
      {session: 's2'}
    );
    assert.equal((await store.getOutcome('T1'))?.outcome, 'delivered');
    assert.equal(Number(db.get('SELECT COUNT(*) AS n FROM claim')?.n), 1);
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
