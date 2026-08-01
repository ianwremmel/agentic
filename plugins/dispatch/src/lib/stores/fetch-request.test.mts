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

  it('each returned id from insert identifies the correct row (pins concurrent race)', async () => {
    const {db, store} = await fresh();
    const id1 = await store.enqueueScan({
      source: 'linear',
      projects: ['P1'],
      cursor: null,
      at: AT,
    });
    const id2 = await store.enqueueTicket({
      source: 'linear',
      ticket: 'A',
      at: AT,
    });
    assert.notEqual(id1, id2);
    // Resolving id1 should affect scan_project, not the ticket
    await store.resolve(id1, 'materialized');
    const [scan] = await store.bySource('linear');
    assert(scan !== undefined);
    assert.equal(scan.id, id1);
    assert.equal(scan.kind, 'scan_project');
    assert.equal(scan.resolution, 'materialized');
    // Resolving id2 should affect the ticket, not the scan
    // eslint-disable-next-line @typescript-eslint/non-nullable-type-assertion-style
    await store.resolve(id2 as number, 'materialized');
    const tickets = (await store.bySource('linear')).filter(
      (r) => r.kind === 'fetch_ticket'
    );
    assert.deepEqual(
      tickets.map((t) => ({id: t.id, resolution: t.resolution})),
      [{id: id2, resolution: 'materialized'}]
    );
    await db.close();
  });

  it('openTicketRequest finds unresolved ticket by name', async () => {
    const {db, store} = await fresh();
    const id = await store.enqueueTicket({
      source: 'linear',
      ticket: 'ISSUE-42',
      at: AT,
    });
    assert.notEqual(id, null);
    const found = await store.openTicketRequest('ISSUE-42');
    assert(found !== null);
    assert.equal(found.id, id);
    assert.equal(found.source, 'linear');
    // After resolving, should not be found
    // eslint-disable-next-line @typescript-eslint/non-nullable-type-assertion-style
    await store.resolve(id as number, 'missing');
    const notFound = await store.openTicketRequest('ISSUE-42');
    assert.equal(notFound, null);
    await db.close();
  });

  it('bySource lists all requests for a source', async () => {
    const {db, store} = await fresh();
    await store.enqueueScan({
      source: 'linear',
      projects: ['P1', 'P2'],
      cursor: 'tok1',
      at: AT,
    });
    await store.enqueueTicket({source: 'linear', ticket: 'A', at: AT});
    await store.enqueueTicket({source: 'linear', ticket: 'B', at: AT});
    await store.enqueueTicket({source: 'jira', ticket: 'C', at: AT});
    assert.deepEqual(
      (await store.bySource('linear')).map((r) => r.kind),
      ['scan_project', 'fetch_ticket', 'fetch_ticket']
    );
    assert.deepEqual(
      (await store.bySource('jira')).map((r) => r.kind),
      ['fetch_ticket']
    );
    await db.close();
  });
});
