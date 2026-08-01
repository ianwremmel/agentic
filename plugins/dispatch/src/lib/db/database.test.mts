import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {EnvironmentError} from '../errors/index.mts';
import {Database} from './database.mts';

describe('Database', () => {
  it('bootstraps the schema so satellites can be written', async () => {
    const db = await Database.open(':memory:');
    db.run("INSERT INTO node (external_id, kind) VALUES ('P1', 'project')");
    db.run('INSERT INTO project (node_id, name) VALUES (?, ?)', [
      Number(db.get("SELECT id FROM node WHERE external_id = 'P1'")?.id),
      'Platform',
    ]);
    assert.equal(db.get('SELECT name FROM project')?.name, 'Platform');
    await db.close();
  });

  it('enforces foreign keys so a bad reference is rejected', async () => {
    const db = await Database.open(':memory:');
    assert.throws(() => {
      db.run('INSERT INTO project (node_id, name) VALUES (999, ?)', ['X']);
    });
    await db.close();
  });

  it('cascades a session delete to its claims', async () => {
    const db = await Database.open(':memory:');
    db.run("INSERT INTO node (external_id, kind) VALUES ('T1', 'ticket')");
    const nid = Number(
      db.get("SELECT id FROM node WHERE external_id = 'T1'")?.id
    );
    db.run(
      "INSERT INTO session (id, started_at, heartbeat_at) VALUES ('s1', '2026-07-31T00:00:00Z', '2026-07-31T00:00:00Z')"
    );
    db.run(
      "INSERT INTO claim (node_id, session_id, claimed_at) VALUES (?, 's1', '2026-07-31T00:00:00Z')",
      [nid]
    );
    db.run("DELETE FROM session WHERE id = 's1'");
    assert.equal(Number(db.get('SELECT COUNT(*) AS n FROM claim')?.n), 0);
    await db.close();
  });

  it('refuses a database written by another schema version', async () => {
    const db = await Database.open(':memory:');
    // Simulate a foreign version, then reopen the same connection's file is not
    // possible for :memory:, so assert the guard path directly:
    db.run("UPDATE meta SET value = '999' WHERE key = 'schema_version'");
    assert.throws(
      () => {
        Database.assertVersion(db, ':memory:');
      },
      (err: unknown) => err instanceof EnvironmentError
    );
    await db.close();
  });
});
