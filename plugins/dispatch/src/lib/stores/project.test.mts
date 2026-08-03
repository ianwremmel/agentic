import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {Database} from '../db/database.mts';
import {ProjectStore} from './project.mts';

async function fresh(): Promise<{db: Database; store: ProjectStore}> {
  const db = await Database.open(':memory:');
  return {db, store: new ProjectStore(db)};
}

describe('ProjectStore', () => {
  it('upserts and reads a project', async () => {
    const {db, store} = await fresh();
    await store.upsertProject({id: 'P1', name: 'Platform'});
    assert.deepEqual(await store.getProject('P1'), {
      id: 'P1',
      name: 'Platform',
      source: null,
    });
    await store.upsertProject({id: 'P1', name: 'Platform Renamed'});
    assert.equal((await store.getProject('P1'))?.name, 'Platform Renamed');
    await db.close();
  });

  it('demotes to a placeholder when a ticket still references it', async () => {
    const {db, store} = await fresh();
    await store.upsertProject({id: 'P1', name: 'Platform'});
    const pid = Number(
      db.get("SELECT id FROM node WHERE external_id='P1'")?.id
    );
    db.run("INSERT INTO node (external_id, kind) VALUES ('CLC-1','ticket')");
    const tid = Number(
      db.get("SELECT id FROM node WHERE external_id='CLC-1'")?.id
    );
    db.run(
      "INSERT INTO ticket (node_id, project_id, url, title, status, target_kind, requires_human, injected, labels) VALUES (?,?, '', 't', 'available', 'pr', 0, 0, '[]')",
      [tid, pid]
    );
    assert.equal(await store.removeProject('P1'), true);
    assert.equal(await store.getProject('P1'), null);
    assert.equal(
      db.get("SELECT kind FROM node WHERE external_id='P1'")?.kind,
      'unknown'
    );
    await db.close();
  });

  it('deletes the node when nothing references it', async () => {
    const {db, store} = await fresh();
    await store.upsertProject({id: 'P1', name: 'Platform'});
    assert.equal(await store.removeProject('P1'), true);
    assert.equal(
      db.get("SELECT 1 FROM node WHERE external_id='P1'"),
      undefined
    );
    await db.close();
  });

  it('round-trips the tracker source', async () => {
    const db = await Database.open(':memory:');
    const store = new ProjectStore(db);
    await store.upsertProject({id: 'P', name: 'Proj', source: 'linear'});
    assert.deepEqual(await store.getProject('P'), {
      id: 'P',
      name: 'Proj',
      source: 'linear',
    });
    await db.close();
  });
});
