import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {Database} from '../db/database.mts';
import {FetchRequestStore} from './fetch-request.mts';

const AT = '2026-08-01T12:00:00.000Z';

async function fresh(): Promise<{db: Database; store: FetchRequestStore}> {
  const db = await Database.open(':memory:');
  return {db, store: new FetchRequestStore(db)};
}

describe('FetchRequestStore', () => {
  it('enqueues a scan and returns it parsed', async () => {
    const {db, store} = await fresh();
    await store.enqueueScan({
      source: 'linear',
      projects: ['P1'],
      cursor: 'tok',
      at: AT,
    });
    const [request] = await store.undelivered();
    assert(request !== undefined);
    assert.equal(request.kind, 'scan_project');
    assert.deepEqual(request.payload, {projects: ['P1'], cursor: 'tok'});
    await db.close();
  });

  it('enqueues one ticket request per id', async () => {
    const {db, store} = await fresh();
    assert.notEqual(
      await store.enqueueTicket({source: 'linear', ticket: 'A', at: AT}),
      null
    );
    assert.equal(
      await store.enqueueTicket({source: 'linear', ticket: 'A', at: AT}),
      null
    );
    assert.equal(await store.openCount('linear'), 1);
    await db.close();
  });

  it('a resolved ticket request still suppresses a re-enqueue', async () => {
    const {db, store} = await fresh();
    const id = await store.enqueueTicket({
      source: 'linear',
      ticket: 'A',
      at: AT,
    });
    assert.notEqual(id, null);
    // eslint-disable-next-line @typescript-eslint/non-nullable-type-assertion-style
    await store.resolve(id as number, 'missing');
    assert.equal(
      await store.enqueueTicket({source: 'linear', ticket: 'A', at: AT}),
      null
    );
    assert.equal(await store.openCount('linear'), 0);
    await db.close();
  });

  it('marking delivered takes a row out of the drain', async () => {
    const {db, store} = await fresh();
    await store.enqueueTicket({source: 'linear', ticket: 'A', at: AT});
    const [request] = await store.undelivered();
    assert(request !== undefined);
    await store.markDelivered(request.id, AT);
    assert.deepEqual(await store.undelivered(), []);
    await db.close();
  });

  it('openTickets lists only unresolved ticket requests', async () => {
    const {db, store} = await fresh();
    await store.enqueueScan({
      source: 'linear',
      projects: [],
      cursor: null,
      at: AT,
    });
    const id = await store.enqueueTicket({
      source: 'linear',
      ticket: 'A',
      at: AT,
    });
    await store.enqueueTicket({source: 'linear', ticket: 'B', at: AT});
    // eslint-disable-next-line @typescript-eslint/non-nullable-type-assertion-style
    await store.resolve(id as number, 'materialized');
    assert.deepEqual(
      (await store.openTickets()).map((t) => t.ticket),
      ['B']
    );
    await db.close();
  });

  it('clear empties one source', async () => {
    const {db, store} = await fresh();
    await store.enqueueTicket({source: 'linear', ticket: 'A', at: AT});
    await store.enqueueTicket({source: 'jira', ticket: 'B', at: AT});
    assert.equal(await store.clear('linear'), 1);
    assert.equal(await store.openCount('jira'), 1);
    await db.close();
  });
});
