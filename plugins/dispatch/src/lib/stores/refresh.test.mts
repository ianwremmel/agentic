import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {Database} from '../db/database.mts';
import {RefreshStore} from './refresh.mts';

const AT = '2026-08-01T12:00:00.000Z';
const LATER = '2026-08-01T12:05:00.000Z';

async function fresh(): Promise<{db: Database; store: RefreshStore}> {
  const db = await Database.open(':memory:');
  return {db, store: new RefreshStore(db)};
}

describe('RefreshStore', () => {
  it('opens a scanning refresh carrying its projects', async () => {
    const {db, store} = await fresh();
    await store.open({
      source: 'linear',
      projects: ['P1', 'P2'],
      sessionId: 's1',
      at: AT,
    });
    const row = await store.get('linear');
    assert(row !== null);
    assert.equal(row.state, 'scanning');
    assert.deepEqual(row.projects, ['P1', 'P2']);
    assert.equal(row.pendingCursor, null);
    await db.close();
  });

  it('re-opening resets the state and clears the pending cursor', async () => {
    const {db, store} = await fresh();
    await store.open({
      source: 'linear',
      projects: ['P1'],
      sessionId: 's1',
      at: AT,
    });
    await store.setPendingCursor('linear', 'tok');
    await store.setState('linear', 'resolving');
    await store.open({
      source: 'linear',
      projects: ['P2'],
      sessionId: 's2',
      at: LATER,
    });
    const row = await store.get('linear');
    assert(row !== null);
    assert.equal(row.state, 'scanning');
    assert.equal(row.pendingCursor, null);
    assert.equal(row.sessionId, 's2');
    await db.close();
  });

  it('reports a closed refresh as owing a completion push exactly once', async () => {
    const {db, store} = await fresh();
    await store.open({source: 'linear', projects: [], sessionId: null, at: AT});
    await store.close('linear', LATER);
    assert.deepEqual(await store.pendingCompletions(), ['linear']);
    await store.markCompletionEmitted('linear', LATER);
    assert.deepEqual(await store.pendingCompletions(), []);
    const row = await store.get('linear');
    assert(row !== null);
    assert.equal(row.state, 'idle');
    await db.close();
  });

  it('has no live session when no session row carries its id', async () => {
    const {db, store} = await fresh();
    await store.open({
      source: 'linear',
      projects: [],
      sessionId: 'gone',
      at: AT,
    });
    assert.equal(await store.hasLiveSession('linear'), false);
    await db.close();
  });

  it('active omits idle sources', async () => {
    const {db, store} = await fresh();
    await store.open({source: 'a', projects: [], sessionId: null, at: AT});
    await store.open({source: 'b', projects: [], sessionId: null, at: AT});
    await store.close('b', LATER);
    assert.deepEqual(
      (await store.active()).map((r) => r.source),
      ['a']
    );
    await db.close();
  });
});
