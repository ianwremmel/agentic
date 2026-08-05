import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {ticket as baseTicket} from '../command/test-support.mts';
import {Database} from '../db/database.mts';
import {DataError} from '../errors/index.mts';
import {milestoneStates} from '../graph/index.mts';
import {
  CoordinationStore,
  EdgeStore,
  MilestoneStore,
  ProjectStore,
  SessionStore,
  TicketStore,
} from './index.mts';
import {ReviewStore} from './review.mts';

const NOW = '2026-08-03T12:00:00.000Z';
const LATER = '2026-08-03T12:01:00.000Z';

async function fixture(): Promise<Database> {
  const db = await Database.open(':memory:');
  await new ProjectStore(db).upsertProject({
    id: 'P',
    name: 'P',
    source: 'linear',
  });
  await new MilestoneStore(db).upsertMilestone({
    id: 'M1',
    project: 'P',
    name: 'M1',
  });
  await new TicketStore(db).upsertTicket({
    ...baseTicket('T1', 'P'),
    status: 'verified',
  });
  await new EdgeStore(db).addEdge('T1', 'M1');
  return db;
}

describe('ReviewStore', () => {
  it('records a review the read-model counts, until the member set changes', async () => {
    const db = await fixture();
    await new ReviewStore(db).record('M1', NOW, 'S1');

    const before = await milestoneStates(db, {now: NOW});
    assert.equal(before[0]?.reviewRecorded, true);

    await new TicketStore(db).upsertTicket({
      ...baseTicket('T2', 'P'),
      status: 'available',
    });
    await new EdgeStore(db).addEdge('T2', 'M1');
    const after = await milestoneStates(db, {now: LATER});
    assert.equal(after[0]?.reviewRecorded, false);
    await db.close();
  });

  it('refuses a milestone with unresolved members', async () => {
    const db = await fixture();
    await new TicketStore(db).upsertTicket({
      ...baseTicket('T2', 'P'),
      status: 'in-progress',
    });
    await new EdgeStore(db).addEdge('T2', 'M1');

    await assert.rejects(
      new ReviewStore(db).record('M1', NOW, 'S1'),
      (err: unknown) => err instanceof DataError && err.message.includes('T2')
    );
    await db.close();
  });

  it('release drops the reviewing claim without opening the gate', async () => {
    const db = await fixture();
    await new SessionStore(db).register({
      id: 'S1',
      startedAt: NOW,
      heartbeatAt: NOW,
    });
    await new CoordinationStore(db).claim({
      node: 'M1',
      session: 'S1',
      claimedAt: NOW,
    });

    const store = new ReviewStore(db);
    assert.equal(await store.release('M1', 'S1'), true);
    assert.equal(await store.release('M1', 'S1'), false);
    assert.deepEqual(await new CoordinationStore(db).claims(), []);
    const state = await milestoneStates(db, {now: NOW});
    assert.equal(state[0]?.reviewRecorded, false);
    await db.close();
  });

  it('refuses a milestone with no members', async () => {
    const db = await Database.open(':memory:');
    await new ProjectStore(db).upsertProject({
      id: 'P',
      name: 'P',
      source: 'linear',
    });
    await new MilestoneStore(db).upsertMilestone({
      id: 'M1',
      project: 'P',
      name: 'M1',
    });

    await assert.rejects(
      new ReviewStore(db).record('M1', NOW, 'S1'),
      (err: unknown) => err instanceof DataError
    );
    await db.close();
  });

  it("leaves another session's review claim alone", async () => {
    const db = await fixture();
    const sessions = new SessionStore(db);
    await sessions.register({id: 'S1', startedAt: NOW, heartbeatAt: NOW});
    await sessions.register({id: 'S2', startedAt: NOW, heartbeatAt: NOW});
    await new CoordinationStore(db).claim({
      node: 'M1',
      session: 'S2',
      claimedAt: NOW,
    });

    // A swept reviewer reporting late must not revoke the replacement's grant.
    assert.equal(await new ReviewStore(db).release('M1', 'S1'), false);
    assert.deepEqual(await new CoordinationStore(db).claims(), [
      {node: 'M1', session: 'S2', actor: null},
    ]);

    // Recording carries the same rule: the gate opens, the live claim stays.
    await new ReviewStore(db).record('M1', NOW, 'S1');
    assert.deepEqual(await new CoordinationStore(db).claims(), [
      {node: 'M1', session: 'S2', actor: null},
    ]);
    await db.close();
  });
});
