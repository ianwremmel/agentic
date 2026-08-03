import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {Database} from '../db/database.mts';
import {DataError} from '../errors/index.mts';
import type {Pr} from '../model/types.mts';
import {PrStore} from './pr.mts';

const BARE: Pr = {
  id: 'acme/api#412',
  ticket: null,
  origin: 'adopted',
  repo: 'acme/api',
  prNumber: 412,
  url: 'https://github.com/acme/api/pull/412',
  branch: 'fix-thing',
  title: 'Fix the thing',
  injected: true,
  priority: null,
  updatedAt: null,
};

async function fresh(): Promise<{db: Database; store: PrStore}> {
  const db = await Database.open(':memory:');
  return {db, store: new PrStore(db)};
}

describe('PrStore', () => {
  it('round-trips a bare PR with no ticket', async () => {
    const {db, store} = await fresh();
    await store.upsertPr(BARE);
    assert.deepEqual(await store.getPr('acme/api#412'), BARE);
    await db.close();
  });

  it('links a ticket-derived PR via a placeholder', async () => {
    const {db, store} = await fresh();
    await store.upsertPr({...BARE, ticket: 'CLC-1', origin: 'ticket'});
    assert.equal((await store.getPr('acme/api#412'))?.ticket, 'CLC-1');
    assert.equal(
      db.get("SELECT kind FROM node WHERE external_id='CLC-1'")?.kind,
      'unknown'
    );
    await db.close();
  });

  it('rejects an unknown origin with a DataError', async () => {
    const {db, store} = await fresh();
    await assert.rejects(
      store.upsertPr({...BARE, origin: 'reopened' as Pr['origin']}),
      (err: unknown) => err instanceof DataError
    );
    await db.close();
  });
});
