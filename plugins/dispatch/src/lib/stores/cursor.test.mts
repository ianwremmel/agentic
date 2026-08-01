import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {Database} from '../db/database.mts';
import {CursorStore} from './cursor.mts';

async function fresh(): Promise<{db: Database; store: CursorStore}> {
  const db = await Database.open(':memory:');
  return {db, store: new CursorStore(db)};
}

describe('CursorStore', () => {
  it('sets, overwrites, reads, and clears a cursor', async () => {
    const {db, store} = await fresh();
    assert.equal(await store.getCursor('linear'), null);
    await store.setCursor('linear', '2026-07-31T00:00:00Z');
    assert.equal(await store.getCursor('linear'), '2026-07-31T00:00:00Z');
    await store.setCursor('linear', '2026-07-31T01:00:00Z');
    assert.equal(await store.getCursor('linear'), '2026-07-31T01:00:00Z');
    assert.equal(await store.clearCursor('linear'), true);
    assert.equal(await store.clearCursor('linear'), false);
    await db.close();
  });
});
