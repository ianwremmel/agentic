import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {Database} from '../db/database.mts';
import {UsageError} from '../errors/index.mts';
import {MilestoneStore} from './milestone.mts';
import {ProjectStore} from './project.mts';

async function fresh(): Promise<{db: Database; store: MilestoneStore}> {
  const db = await Database.open(':memory:');
  await new ProjectStore(db).upsertProject({
    id: 'P1',
    name: 'P1',
    source: 'linear',
  });
  return {db, store: new MilestoneStore(db)};
}

describe('MilestoneStore', () => {
  it('upserts and reads a milestone under its recorded project', async () => {
    const {db, store} = await fresh();
    await store.upsertMilestone({id: 'M1', project: 'P1', name: 'Alpha'});
    assert.deepEqual(await store.getMilestone('M1'), {
      id: 'M1',
      project: 'P1',
      name: 'Alpha',
    });
    await db.close();
  });

  it('rejects a project that is not recorded instead of re-parenting silently', async () => {
    // Same failure mode as tickets: a name passed where the id belongs used
    // to materialize an unknown-kind placeholder and quietly parent the
    // milestone onto it. The write must fail loudly instead.
    const {db, store} = await fresh();
    await assert.rejects(
      store.upsertMilestone({id: 'M1', project: 'Anyhook', name: 'Alpha'}),
      (err: unknown) => err instanceof UsageError
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
