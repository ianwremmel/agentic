import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {ticket as baseTicket} from '../command/test-support.mts';
import {Database} from '../db/database.mts';
import {DataError} from '../errors/index.mts';
import {EdgeStore} from './edge.mts';
import {MilestoneStore} from './milestone.mts';
import {PrStore} from './pr.mts';
import {ProjectStore} from './project.mts';
import {TicketStore} from './ticket.mts';

async function fresh(): Promise<{db: Database; store: EdgeStore}> {
  const db = await Database.open(':memory:');
  return {db, store: new EdgeStore(db)};
}

describe('EdgeStore', () => {
  it('adds an edge between placeholders and is idempotent', async () => {
    const {db, store} = await fresh();
    assert.equal(await store.addEdge('A', 'B'), true);
    assert.equal(await store.addEdge('A', 'B'), false);
    assert.deepEqual(await store.edges(), [{blocker: 'A', blocked: 'B'}]);
    await db.close();
  });

  it('rejects a self-edge', async () => {
    const {db, store} = await fresh();
    await assert.rejects(
      store.addEdge('A', 'A'),
      (err: unknown) => err instanceof DataError
    );
    await db.close();
  });

  it('rejects an edge that would close a cycle', async () => {
    const {db, store} = await fresh();
    await store.addEdge('A', 'B');
    await store.addEdge('B', 'C');
    await assert.rejects(
      store.addEdge('C', 'A'),
      (err: unknown) => err instanceof DataError
    );
    await db.close();
  });

  it('setEdges replaces one direction atomically', async () => {
    const {db, store} = await fresh();
    await store.addEdge('X', 'N');
    await store.setEdges('N', 'blockers', ['Y', 'Z']);
    const blockers = (await store.edges())
      .filter((e) => e.blocked === 'N')
      .map((e) => e.blocker)
      .sort();
    assert.deepEqual(blockers, ['Y', 'Z']);
    await db.close();
  });

  it('leaves a PR item blocker in place when the tracker redeclares blockers', async () => {
    const {db, store} = await fresh();
    await new ProjectStore(db).upsertProject({
      id: 'P',
      name: 'P',
      source: 'linear',
    });
    const tickets = new TicketStore(db);
    for (const id of ['T', 'OLD', 'NEW']) {
      await tickets.upsertTicket(baseTicket(id, 'P'));
    }
    await new PrStore(db).upsertPr({
      id: 'o/r#feat',
      ticket: 'T',
      origin: 'ticket',
      repo: 'o/r',
      prNumber: null,
      url: null,
      branch: 'feat',
      title: 'implements T',
      injected: false,
      priority: null,
      updatedAt: null,
    });
    await store.addEdge('o/r#feat', 'T');
    await store.addEdge('OLD', 'T');

    await store.setEdges('T', 'blockers', ['NEW']);

    const blockers = (await store.edges())
      .filter((e) => e.blocked === 'T')
      .map((e) => e.blocker)
      .sort();
    assert.deepEqual(blockers, ['NEW', 'o/r#feat']);
    await db.close();
  });

  it('leaves milestone membership in place when the blocks side is redeclared', async () => {
    const {db, store} = await fresh();
    await new ProjectStore(db).upsertProject({
      id: 'P',
      name: 'P',
      source: 'linear',
    });
    const tickets = new TicketStore(db);
    for (const id of ['T', 'OLD', 'NEW']) {
      await tickets.upsertTicket(baseTicket(id, 'P'));
    }
    await new MilestoneStore(db).upsertMilestone({
      id: 'M1',
      project: 'P',
      name: 'M1',
    });
    await store.addEdge('T', 'M1');
    await store.addEdge('T', 'OLD');

    await store.setEdges('T', 'blocks', ['NEW']);

    const blocks = (await store.edges())
      .filter((e) => e.blocker === 'T')
      .map((e) => e.blocked)
      .sort();
    assert.deepEqual(blocks, ['M1', 'NEW']);
    await db.close();
  });
});
