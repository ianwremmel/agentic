import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {Database} from '../db/database.mts';
import {DataError} from '../errors/index.mts';
import {EdgeStore} from './edge.mts';

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
});
