import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {Database} from '../db/database.mts';
import {MilestoneStore} from './milestone.mts';

async function fresh(): Promise<{db: Database; store: MilestoneStore}> {
  const db = await Database.open(':memory:');
  return {db, store: new MilestoneStore(db)};
}

describe('MilestoneStore', () => {
  it('upserts and reads a milestone, placeholdering its project', async () => {
    const {db, store} = await fresh();
    await store.upsertMilestone({id: 'M1', project: 'P1', name: 'Alpha'});
    assert.deepEqual(await store.getMilestone('M1'), {
      id: 'M1',
      project: 'P1',
      name: 'Alpha',
    });
    assert.equal(
      db.get("SELECT kind FROM node WHERE external_id='P1'")?.kind,
      'unknown'
    );
    await db.close();
  });

  it('removing a milestone cascades its membership edges', async () => {
    const {db, store} = await fresh();
    await store.upsertMilestone({id: 'M1', project: 'P1', name: 'Alpha'});
    const mid = Number(
      db.get("SELECT id FROM node WHERE external_id='M1'")?.id
    );
    db.run("INSERT INTO node (external_id, kind) VALUES ('CLC-1','ticket')");
    const tid = Number(
      db.get("SELECT id FROM node WHERE external_id='CLC-1'")?.id
    );
    db.run('INSERT INTO edge (blocker, blocked) VALUES (?, ?)', [tid, mid]);
    assert.equal(await store.removeMilestone('M1'), true);
    assert.equal(Number(db.get('SELECT COUNT(*) AS n FROM edge')?.n), 0);
    assert.equal(await store.getMilestone('M1'), null);
    await db.close();
  });
});
