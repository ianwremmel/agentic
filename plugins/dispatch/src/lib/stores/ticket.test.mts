import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {Database} from '../db/database.mts';
import {DataError} from '../errors/index.mts';
import type {Ticket} from '../model/types.mts';
import {TicketStore} from './ticket.mts';

const BASE: Ticket = {
  id: 'CLC-1',
  project: 'P1',
  url: 'https://x/CLC-1',
  title: 'Do the thing',
  status: 'available',
  targetKind: 'pr',
  requiresHuman: false,
  injected: false,
  priority: 2.5,
  branchHint: 'clc-1',
  labels: ['backend', 'urgent'],
  updatedAt: '2026-07-31T12:00:00.000Z',
};

async function fresh(): Promise<{db: Database; store: TicketStore}> {
  const db = await Database.open(':memory:');
  return {db, store: new TicketStore(db)};
}

describe('TicketStore', () => {
  it('round-trips a ticket including labels and booleans', async () => {
    const {db, store} = await fresh();
    await store.upsertTicket(BASE);
    assert.deepEqual(await store.getTicket('CLC-1'), BASE);
    await db.close();
  });

  it('rejects an unknown status with a DataError', async () => {
    const {db, store} = await fresh();
    await assert.rejects(
      store.upsertTicket({...BASE, status: 'nope' as Ticket['status']}),
      (err: unknown) => err instanceof DataError
    );
    await db.close();
  });

  it('removing a ticket cascades its edges and claim', async () => {
    const {db, store} = await fresh();
    await store.upsertTicket(BASE);
    const tid = Number(
      db.get("SELECT id FROM node WHERE external_id='CLC-1'")?.id
    );
    db.run("INSERT INTO node (external_id, kind) VALUES ('M1','milestone')");
    const mid = Number(
      db.get("SELECT id FROM node WHERE external_id='M1'")?.id
    );
    db.run('INSERT INTO edge (blocker, blocked) VALUES (?, ?)', [tid, mid]);
    assert.equal(await store.removeTicket('CLC-1'), true);
    assert.equal(Number(db.get('SELECT COUNT(*) AS n FROM edge')?.n), 0);
    await db.close();
  });
});
