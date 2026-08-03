import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after, describe, it} from 'node:test';

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

// The rest of the suite runs against ':memory:', where WAL is a no-op and no
// file is ever created. These exercise the on-disk path the shared database
// actually uses: WAL, directory creation, persistence across reopen, and the
// version refusal against a real file rather than the static guard.
describe('Database (file-backed)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-db-'));
  after(() => {
    rmSync(dir, {recursive: true, force: true});
  });

  it('creates the directory and enables WAL and foreign keys on a real file', async () => {
    const db = await Database.open(join(dir, 'nested', 'wal.db'));
    assert.equal(db.get('PRAGMA journal_mode')?.journal_mode, 'wal');
    assert.equal(db.get('PRAGMA foreign_keys')?.foreign_keys, 1);
    await db.close();
  });

  it('persists rows across a close and reopen of the same file', async () => {
    const path = join(dir, 'persist.db');

    const db = await Database.open(path);
    db.run("INSERT INTO node (external_id, kind) VALUES ('P1', 'project')");
    db.run('INSERT INTO project (node_id, name) VALUES (?, ?)', [
      Number(db.get("SELECT id FROM node WHERE external_id = 'P1'")?.id),
      'Platform',
    ]);
    await db.close();

    const reopened = await Database.open(path);
    assert.equal(reopened.get('SELECT name FROM project')?.name, 'Platform');
    await reopened.close();
  });

  it('refuses to reopen a file written by another schema version', async () => {
    const path = join(dir, 'version.db');

    const db = await Database.open(path);
    db.run("UPDATE meta SET value = '999' WHERE key = 'schema_version'");
    await db.close();

    await assert.rejects(
      Database.open(path),
      (err: unknown) => err instanceof EnvironmentError
    );
  });
});

describe('Database.transaction misuse', () => {
  it('refuses an async body rather than committing early', async () => {
    const db = await Database.open(':memory:');
    await assert.rejects(
      // eslint-disable-next-line @typescript-eslint/require-await -- the async body is the misuse under test
      db.transaction(async () => 1),
      (err: unknown) =>
        err instanceof Error && err.message.includes('must be synchronous')
    );
    await db.close();
  });
});
