import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {describe, it} from 'node:test';

import type {Database} from './database.mts';
import {resolveDbPath, withDatabase} from './with-database.mts';

describe('resolveDbPath', () => {
  it('prefers the flag over the environment', () => {
    assert.equal(
      resolveDbPath('/flag.db', {DISPATCH_DB: '/env.db'}),
      '/flag.db'
    );
  });

  it('falls back to DISPATCH_DB, then the XDG state directory', () => {
    assert.equal(resolveDbPath(undefined, {DISPATCH_DB: '/env.db'}), '/env.db');
    assert.equal(
      resolveDbPath(undefined, {XDG_STATE_HOME: '/state'}),
      path.join('/state', 'dispatch', 'graph.db')
    );
  });
});

describe('withDatabase', () => {
  it('closes the handle even when the body throws', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'dispatch-db-'));
    const file = path.join(dir, 'graph.db');

    let captured: Database | undefined;
    await assert.rejects(
      withDatabase(file, {}, (db) => {
        captured = db;
        throw new Error('boom');
      })
    );

    assert(captured !== undefined);
    const db = captured;
    // A closed handle cannot prepare a statement; a leaked one would answer.
    assert.throws(() => db.all('SELECT 1 AS one'));
  });
});
