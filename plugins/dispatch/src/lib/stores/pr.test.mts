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

  it('patch leaves fields the caller did not name alone', async () => {
    // The documented pr-worker call keeps "URL and PR number" current and
    // names nothing else. Assigning every column from such a write is how a
    // ticket-backed item loses its ticket link, its title, and its origin.
    const {db, store} = await fresh();
    await store.upsertPr({
      id: 'o/r#feat',
      ticket: 'T-1',
      origin: 'ticket',
      repo: 'o/r',
      prNumber: null,
      url: null,
      branch: 'feat',
      title: 'build the thing',
      injected: false,
      priority: 2,
      updatedAt: null,
    });

    await store.patchPr({
      id: 'o/r#feat',
      url: 'https://example.test/pr/7',
      prNumber: 7,
    });

    const pr = await store.getPr('o/r#feat');
    assert(pr !== null);
    assert.equal(pr.url, 'https://example.test/pr/7');
    assert.equal(pr.prNumber, 7);
    assert.equal(pr.ticket, 'T-1');
    assert.equal(pr.title, 'build the thing');
    assert.equal(pr.origin, 'ticket');
    assert.equal(pr.priority, 2);
    assert.equal(pr.branch, 'feat');
    await db.close();
  });

  it('patch creates the row when the id is new, defaulting what it was not given', async () => {
    const {db, store} = await fresh();
    await store.patchPr({id: 'o/r#8', repo: 'o/r', prNumber: 8});

    const pr = await store.getPr('o/r#8');
    assert(pr !== null);
    assert.equal(pr.repo, 'o/r');
    assert.equal(pr.prNumber, 8);
    assert.equal(pr.origin, 'prompt');
    assert.equal(pr.title, '');
    assert.equal(pr.ticket, null);
    await db.close();
  });

  it('patch clears a field given an explicit empty value', async () => {
    const {db, store} = await fresh();
    await store.upsertPr({
      id: 'o/r#9',
      ticket: 'T-1',
      origin: 'ticket',
      repo: 'o/r',
      prNumber: 9,
      url: null,
      branch: null,
      title: 'x',
      injected: false,
      priority: null,
      updatedAt: null,
    });

    await store.patchPr({id: 'o/r#9', ticket: null});

    const pr = await store.getPr('o/r#9');
    assert(pr !== null);
    assert.equal(pr.ticket, null);
    assert.equal(pr.title, 'x');
    await db.close();
  });
});
