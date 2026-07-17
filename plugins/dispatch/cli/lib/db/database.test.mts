import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {describe, it} from 'node:test';

import {EnvironmentError} from '../errors.mts';
import {Database} from './database.mts';

describe('schema version', () => {
  it('refuses a database another schema version wrote, naming the version found', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'dispatch-db-'));
    const file = path.join(dir, 'dispatch.db');

    const db = await Database.open(file);
    db.run("UPDATE meta SET value = '1' WHERE key = 'schema_version'");
    await db.close();

    await assert.rejects(
      () => Database.open(file),
      (error: unknown) => {
        assert.ok(error instanceof EnvironmentError);
        assert.match(error.message, /another schema version/u);
        assert.equal(error.details?.found, '1');
        return true;
      }
    );
  });
});

describe('constraints', () => {
  it('enforces enum CHECKs and foreign keys at the SQL layer', async () => {
    // The store validates first, but the schema is the last line of defense
    // against any writer that skips it.
    const db = await Database.open(':memory:');

    assert.throws(
      () =>
        db.run("INSERT INTO node (external_id, kind) VALUES ('X', 'thing')"),
      /rejected an operation/
    );
    assert.throws(
      // node 999 does not exist: the edge FK must refuse it.
      () => db.run('INSERT INTO edge (blocker, blocked) VALUES (999, 998)'),
      /rejected an operation/
    );
    assert.throws(
      // A self-edge violates the CHECK even where both ends exist.
      () => {
        db.run(
          "INSERT INTO node (id, external_id, kind) VALUES (1, 'A', 'task')"
        );
        db.run('INSERT INTO edge (blocker, blocked) VALUES (1, 1)');
      },
      /rejected an operation/
    );
    await db.close();
  });

  it('cascades a node deletion through its satellites', async () => {
    const db = await Database.open(':memory:');
    db.run("INSERT INTO node (id, external_id, kind) VALUES (1, 'A', 'task')");
    db.run("INSERT INTO node (id, external_id, kind) VALUES (2, 'B', 'task')");
    db.run('INSERT INTO edge (blocker, blocked) VALUES (1, 2)');
    db.run(
      "INSERT INTO claim (node_id, agent, heartbeat_at_ms) VALUES (1, 'a', 0)"
    );

    db.run('DELETE FROM node WHERE id = 1');
    assert.equal(db.all('SELECT * FROM edge').length, 0);
    assert.equal(db.all('SELECT * FROM claim').length, 0);
    await db.close();
  });
});
