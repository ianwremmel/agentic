import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {Database} from '../db/database.mts';
import {DataError} from '../errors/index.mts';
import {findNode, materialize, nodeRef} from './materialize.mts';

describe('materialize', () => {
  it('creates a node with its kind', async () => {
    const db = await Database.open(':memory:');
    const id = materialize(db, 'CLC-1', 'ticket');
    assert.equal(findNode(db, 'CLC-1')?.kind, 'ticket');
    assert.equal(findNode(db, 'CLC-1')?.id, id);
    await db.close();
  });

  it('promotes a placeholder created by nodeRef', async () => {
    const db = await Database.open(':memory:');
    const placeholder = nodeRef(db, 'CLC-1');
    assert.equal(findNode(db, 'CLC-1')?.kind, 'unknown');
    const promoted = materialize(db, 'CLC-1', 'ticket');
    assert.equal(promoted, placeholder, 'promotion keeps the same node id');
    assert.equal(findNode(db, 'CLC-1')?.kind, 'ticket');
    await db.close();
  });

  it('rejects reusing an id as a second concrete kind', async () => {
    const db = await Database.open(':memory:');
    materialize(db, 'CLC-1', 'ticket');
    assert.throws(
      () => materialize(db, 'CLC-1', 'milestone'),
      (err: unknown) => err instanceof DataError
    );
    await db.close();
  });
});
