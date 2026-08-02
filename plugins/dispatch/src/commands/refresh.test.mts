import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {describe, it} from 'node:test';

import {runCommand} from '../lib/command/test-support.mts';
import {withDatabase} from '../lib/db/index.mts';
import {nowIso} from '../lib/db/time.mts';
import {RefreshService} from '../lib/refresh/index.mts';
import {
  CursorStore,
  EdgeStore,
  FetchRequestStore,
  findNode,
  ProjectStore,
  SessionStore,
  TicketStore,
} from '../lib/stores/index.mts';
import type {Ticket} from '../lib/model/index.mts';
import {Command as RefreshCommand} from './refresh.mts';
import {Command as DoneCommand} from './refresh/done.mts';
import {Command as StatusCommand} from './refresh/status.mts';

async function tempEnv(): Promise<NodeJS.ProcessEnv> {
  const dir = await mkdtemp(path.join(tmpdir(), 'dispatch-cmd-'));
  return {DISPATCH_DB: path.join(dir, 'graph.db')};
}

function ticket(id: string, project: string): Ticket {
  return {
    id,
    project,
    url: `https://example.test/${id}`,
    title: id,
    status: 'available',
    targetKind: 'pr',
    requiresHuman: false,
    injected: false,
    priority: null,
    branchHint: null,
    labels: [],
    updatedAt: null,
  };
}

describe('refresh', () => {
  it('opens a refresh and queues one scan', async () => {
    const env = await tempEnv();
    const out = await runCommand(
      new RefreshCommand(),
      {tracker: 'linear', project: 'P1,P2'},
      env
    );
    assert.equal(out, 'refresh linear opened\n');
    const queued = await withDatabase(undefined, env, async (db) =>
      new FetchRequestStore(db).undelivered()
    );
    assert.equal(queued.length, 1);
    const [request] = queued;
    assert(request !== undefined);
    assert.deepEqual(request.payload, {
      projects: ['P1', 'P2'],
      cursor: null,
    });
  });

  it('done on an empty graph closes the refresh', async () => {
    const env = await tempEnv();
    await runCommand(
      new RefreshCommand(),
      {tracker: 'linear', project: 'P'},
      env
    );
    const out = await runCommand(
      new DoneCommand(),
      {tracker: 'linear', cursor: 'tok'},
      env
    );
    assert.equal(out, 'refresh linear idle\n');
  });

  it('resumes an already-open refresh owned by a live session, without a second scan', async () => {
    const env = await tempEnv();
    const at = nowIso();
    await withDatabase(undefined, env, async (db) =>
      new SessionStore(db).register({
        id: 'S1',
        startedAt: at,
        heartbeatAt: at,
      })
    );
    const liveEnv = {...env, CLAUDE_CODE_SESSION_ID: 'S1'};

    const first = await runCommand(
      new RefreshCommand(),
      {tracker: 'linear', project: 'P'},
      liveEnv
    );
    assert.equal(first, 'refresh linear opened\n');

    const second = await runCommand(
      new RefreshCommand(),
      {tracker: 'linear', project: 'P'},
      liveEnv
    );
    assert.equal(second, 'refresh linear resumed\n');

    const queued = await withDatabase(undefined, env, async (db) =>
      new FetchRequestStore(db).undelivered()
    );
    assert.equal(queued.length, 1);
  });

  it('--rebuild drops the graph and queues a scan with no cursor', async () => {
    const env = await tempEnv();
    await withDatabase(undefined, env, async (db) => {
      await new ProjectStore(db).upsertProject({
        id: 'P',
        name: 'P',
        source: 'linear',
      });
      await new TicketStore(db).upsertTicket(ticket('T1', 'P'));
      await new CursorStore(db).setCursor('linear', 'stale-tok');
    });

    await runCommand(
      new RefreshCommand(),
      {tracker: 'linear', project: 'P', rebuild: true},
      env
    );

    const node = await withDatabase(undefined, env, (db) => findNode(db, 'T1'));
    assert.equal(node, null);

    const queued = await withDatabase(undefined, env, async (db) =>
      new FetchRequestStore(db).undelivered()
    );
    assert.equal(queued.length, 1);
    const [request] = queued;
    assert(request !== undefined);
    assert.deepEqual(request.payload, {projects: ['P'], cursor: null});
  });

  it('done with a dangling reference reports resolving and one pending line per id', async () => {
    const env = await tempEnv();
    await runCommand(
      new RefreshCommand(),
      {tracker: 'linear', project: 'P'},
      env
    );
    await withDatabase(undefined, env, async (db) => {
      await new ProjectStore(db).upsertProject({
        id: 'P',
        name: 'P',
        source: 'linear',
      });
      await new TicketStore(db).upsertTicket(ticket('T1', 'P'));
      await new EdgeStore(db).addEdge('MISSING', 'T1');
    });

    const out = await runCommand(
      new DoneCommand(),
      {tracker: 'linear', cursor: 'tok'},
      env
    );
    assert.equal(out, 'refresh linear resolving\npending MISSING\n');
  });

  it('status reports the state and one line per undelivered instruction', async () => {
    const env = await tempEnv();
    await runCommand(
      new RefreshCommand(),
      {tracker: 'linear', project: 'P'},
      env
    );

    const out = await runCommand(new StatusCommand(), {tracker: 'linear'}, env);
    assert.equal(
      out,
      'refresh linear scanning\n' +
        'scan_project {"projects":["P"],"cursor":null} delivered=false\n'
    );
  });

  it('status reports "none" when no refresh has ever run', async () => {
    const env = await tempEnv();
    const out = await runCommand(new StatusCommand(), {tracker: 'linear'}, env);
    assert.equal(out, 'refresh linear none\n');
  });

  it('status lists a still-open request but omits one already resolved', async () => {
    const env = await tempEnv();
    await runCommand(
      new RefreshCommand(),
      {tracker: 'linear', project: 'P'},
      env
    );
    await withDatabase(undefined, env, async (db) => {
      await new ProjectStore(db).upsertProject({
        id: 'P',
        name: 'P',
        source: 'linear',
      });
      await new TicketStore(db).upsertTicket(ticket('T1', 'P'));
      await new EdgeStore(db).addEdge('RESOLVED', 'T1');
      await new EdgeStore(db).addEdge('OPEN', 'T1');
    });
    // `done` moves the refresh to `resolving`, which is what lets reconcile
    // chase the two placeholders left by the edges above into fetch_ticket
    // requests (reconcile skips placeholder-chasing while `scanning`).
    await runCommand(
      new DoneCommand(),
      {tracker: 'linear', cursor: 'tok'},
      env
    );
    await withDatabase(undefined, env, (db) =>
      new RefreshService(db).markMissing('RESOLVED')
    );

    const out = await runCommand(new StatusCommand(), {tracker: 'linear'}, env);
    assert.ok(
      out.includes('OPEN'),
      `expected the still-open request to be listed, got: ${out}`
    );
    assert.ok(
      !out.includes('RESOLVED'),
      `expected the resolved request to be omitted, got: ${out}`
    );
  });
});
