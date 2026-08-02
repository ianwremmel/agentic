import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {describe, it} from 'node:test';

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
    await assert.rejects(
      withDatabase(file, {}, () => {
        throw new Error('boom');
      })
    );
    // A leaked handle would leave the file locked for the next opener.
    const rows = await withDatabase(file, {}, (db) =>
      db.all('SELECT 1 AS one')
    );
    assert.equal(rows.length, 1);
  });
});
