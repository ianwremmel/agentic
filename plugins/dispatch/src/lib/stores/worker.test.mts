import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {Database} from '../db/database.mts';
import {CoordinationStore} from './coordination.mts';
import {WorkerStore} from './worker.mts';

const NOW = '2026-08-07T12:00:00.000Z';
const LATER = '2026-08-07T12:30:00.000Z';

async function fixture(): Promise<Database> {
  const db = await Database.open(':memory:');
  db.run(
    "INSERT INTO node (external_id, kind) VALUES ('T1','ticket'), ('o/r#1','pr')"
  );
  db.run(
    "INSERT INTO session (id, started_at, heartbeat_at) VALUES ('S1', ?, ?), ('S2', ?, ?)",
    [NOW, NOW, NOW, NOW]
  );
  return db;
}

describe('WorkerStore', () => {
  it('records where a node’s worker can be reached, per session', async () => {
    const db = await fixture();
    await new CoordinationStore(db).claim({
      node: 'T1',
      session: 'S1',
      claimedAt: NOW,
    });
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
    await new CoordinationStore(db).claim({
      node: 'T1',
      session: 'S1',
      claimedAt: NOW,
    });
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
    await new CoordinationStore(db).claim({
      node: 'T1',
      session: 'S1',
      claimedAt: NOW,
    });
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

describe('worker rows arbitrate warm relay vs cold resume', () => {
  it('worker set refuses once the outcome already landed', async () => {
    const db = await fixture();
    const coordination = new CoordinationStore(db);
    await coordination.claim({node: 'T1', session: 'S1', claimedAt: NOW});
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
    // The fast-worker race: outcome recorded before the launcher got to
    // `worker set`. Recreating the row would address an agent that finished.
    await assert.rejects(
      new WorkerStore(db).set({
        node: 'T1',
        session: 'S1',
        agentRef: 'a',
        at: NOW,
      }),
      (err: unknown) => err instanceof Error && err.message.includes('no claim')
    );
    await db.close();
  });

  it('remove is scoped to the owner and hands the node to cold recovery', async () => {
    const db = await fixture();
    const coordination = new CoordinationStore(db);
    await coordination.claim({node: 'T1', session: 'S1', claimedAt: NOW});
    const store = new WorkerStore(db);
    await store.set({node: 'T1', session: 'S1', agentRef: 'a', at: NOW});

    // Another session cannot revoke S1's address out from under it, and is
    // told so rather than that the node has no worker — `dispatch status`
    // would show it one.
    assert.equal(await store.remove('T1', 'S2'), 'not-yours');
    assert.equal(await store.refFor('T1', 'S1'), 'a');

    // The owner's removal releases the claim too: with both gone the
    // scheduler may re-serve the node as a resume pass.
    assert.equal(await store.remove('T1', 'S1', {turn: NOW}), 'removed');
    assert.deepEqual(await coordination.claims(), []);
    await db.close();
  });

  it('keeps a yielded worker for the relay it is waiting on', async () => {
    const db = await fixture();
    const coordination = new CoordinationStore(db);
    const store = new WorkerStore(db);
    await coordination.claim({node: 'o/r#1', session: 'S1', claimedAt: NOW});
    await store.set({node: 'o/r#1', session: 'S1', agentRef: 'a', at: NOW});
    // A yield hands the claim back and keeps the address. The session runs
    // this every time a relayed agent returns, and a yield is one of the ways
    // an agent returns, so removing here would downgrade a working warm path
    // to a cold restart.
    await coordination.release('o/r#1', 'S1');
    assert.equal(
      await store.remove('o/r#1', 'S1', {turn: NOW}),
      'not-this-turn'
    );
    assert.equal(await store.refFor('o/r#1', 'S1'), 'a');

    // The operator retiring a live-but-useless agent by hand still can.
    assert.equal(await store.remove('o/r#1', 'S1', {force: true}), 'removed');
    assert.equal(await store.refFor('o/r#1', 'S1'), null);
    await db.close();
  });

  it('names the caller mistake rather than reporting a live turn as settled', async () => {
    const db = await fixture();
    const coordination = new CoordinationStore(db);
    const store = new WorkerStore(db);
    await coordination.claim({node: 'o/r#1', session: 'S1', claimedAt: NOW});
    await store.set({node: 'o/r#1', session: 'S1', agentRef: 'a', at: NOW});
    // Reporting nothing is not the same as reporting a turn that lost: one is
    // fixable by the caller, the other is the guard doing its job, and an
    // agent that cannot tell them apart retries the wrong one.
    assert.equal(await store.remove('o/r#1', 'S1'), 'no-turn');
    assert.equal(await store.refFor('o/r#1', 'S1'), 'a');
    await db.close();
  });

  it('matches a turn on the instant, not its spelling', async () => {
    const db = await fixture();
    const coordination = new CoordinationStore(db);
    const store = new WorkerStore(db);
    await coordination.claim({node: 'o/r#1', session: 'S1', claimedAt: NOW});
    await store.set({node: 'o/r#1', session: 'S1', agentRef: 'a', at: NOW});
    // The caller is an agent copying a token out of an event. A refusal has to
    // mean a different turn, never a differently-written one — that would pin
    // the item on a formatting difference nobody can see.
    assert.equal(
      await store.remove('o/r#1', 'S1', {turn: '2026-08-07T12:00:00Z'}),
      'removed'
    );
    await db.close();
  });

  it('keeps an address whose claim another session took', async () => {
    const db = await fixture();
    const coordination = new CoordinationStore(db);
    const store = new WorkerStore(db);
    await coordination.claim({node: 'o/r#1', session: 'S1', claimedAt: NOW});
    await store.set({node: 'o/r#1', session: 'S1', agentRef: 'a', at: NOW});
    await coordination.release('o/r#1', 'S1');
    // Another server won the node after the yield. Its worker is the live
    // one; S1's turn is not S1's to report on any more.
    await coordination.claim({node: 'o/r#1', session: 'S2', claimedAt: NOW});
    assert.equal(
      await store.remove('o/r#1', 'S1', {turn: NOW}),
      'not-this-turn'
    );
    assert.deepEqual(
      (await coordination.claims()).map((c) => c.session),
      ['S2']
    );
    await db.close();
  });

  it('refuses a turn that is not an instant', async () => {
    const db = await fixture();
    const coordination = new CoordinationStore(db);
    const store = new WorkerStore(db);
    await coordination.claim({node: 'o/r#1', session: 'S1', claimedAt: NOW});
    await store.set({node: 'o/r#1', session: 'S1', agentRef: 'a', at: NOW});
    // A mangled token would otherwise fail the compare and read as "kept",
    // hiding the caller's mistake behind a correct-looking refusal.
    await assert.rejects(
      store.remove('o/r#1', 'S1', {turn: 'yesterday'}),
      (err: unknown) => err instanceof Error && err.message.includes('turn')
    );
    await db.close();
  });

  it('unpins a relayed worker that died mid-turn, but never a later turn', async () => {
    const db = await fixture();
    const coordination = new CoordinationStore(db);
    const store = new WorkerStore(db);
    await coordination.claim({node: 'o/r#1', session: 'S1', claimedAt: NOW});
    await store.set({node: 'o/r#1', session: 'S1', agentRef: 'a', at: NOW});
    await coordination.release('o/r#1', 'S1');

    // The relay re-takes the claim so the worker can record its outcome, and
    // dates the turn it hands out. A second relay lands before the session
    // gets to the first agent's return: cleaning up on that stale one would
    // delete a working agent's grant and let cold recovery race it.
    await coordination.claim({node: 'o/r#1', session: 'S1', claimedAt: LATER});
    assert.equal(
      await store.remove('o/r#1', 'S1', {turn: NOW}),
      'not-this-turn'
    );
    // With no turn at all, nothing says which one is being reported on.
    assert.equal(await store.remove('o/r#1', 'S1'), 'no-turn');
    assert.equal(await store.refFor('o/r#1', 'S1'), 'a');

    // The current turn's agent returns having recorded nothing. Its liveness
    // is the session's, so without this the row and the claim pin the item
    // out of the queue for good.
    assert.equal(await store.remove('o/r#1', 'S1', {turn: LATER}), 'removed');
    assert.equal(await store.refFor('o/r#1', 'S1'), null);
    assert.deepEqual(await coordination.claims(), []);
    await db.close();
  });

  it('rejects an empty address', async () => {
    const db = await fixture();
    await new CoordinationStore(db).claim({
      node: 'T1',
      session: 'S1',
      claimedAt: NOW,
    });
    await assert.rejects(
      new WorkerStore(db).set({
        node: 'T1',
        session: 'S1',
        agentRef: '  ',
        at: NOW,
      }),
      (err: unknown) => err instanceof Error && err.message.includes('empty')
    );
    await db.close();
  });
});

describe('event meta routing key', () => {
  it('stores the trimmed address', async () => {
    const db = await fixture();
    await new CoordinationStore(db).claim({
      node: 'T1',
      session: 'S1',
      claimedAt: NOW,
    });
    const store = new WorkerStore(db);
    // A padded ref would pass validation and then be unreachable verbatim.
    await store.set({node: 'T1', session: 'S1', agentRef: ' a-1 ', at: NOW});
    assert.equal(await store.refFor('T1', 'S1'), 'a-1');
    await db.close();
  });
});
