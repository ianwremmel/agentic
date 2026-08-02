import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {describe, it} from 'node:test';

import {runCommand} from '../../lib/command/test-support.mts';
import {withDatabase} from '../../lib/db/index.mts';
import {DataError} from '../../lib/errors/index.mts';
import type {Ticket} from '../../lib/model/index.mts';
import {
  EdgeStore,
  FetchRequestStore,
  ProjectStore,
  TicketStore,
} from '../../lib/stores/index.mts';
import {Command as AddCommand} from './add.mts';
import {Command as RmCommand} from './rm.mts';
import {Command as SetCommand} from './set.mts';

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

describe('edge set', () => {
  it('replaces every blocker of a node in one call', async () => {
    const env = await tempEnv();
    await runCommand(new AddCommand(), {blocker: 'OLD', blocked: 'N'}, env);
    await runCommand(
      new SetCommand(),
      {node: 'N', direction: 'blockers', others: 'A,B'},
      env
    );
    const blockers = (
      await withDatabase(undefined, env, async (db) =>
        new EdgeStore(db).edges()
      )
    )
      .filter((edge) => edge.blocked === 'N')
      .map((edge) => edge.blocker)
      .sort();
    assert.deepEqual(blockers, ['A', 'B']);
  });

  it('clears a direction when --others is empty', async () => {
    const env = await tempEnv();
    await runCommand(new AddCommand(), {blocker: 'A', blocked: 'N'}, env);
    const output = await runCommand(
      new SetCommand(),
      {node: 'N', direction: 'blockers', others: ''},
      env
    );
    const blockers = (
      await withDatabase(undefined, env, (db) => new EdgeStore(db).edges())
    ).filter((edge) => edge.blocked === 'N');
    assert.deepEqual(blockers, []);
    assert.equal(output, 'edges of N (blockers) = \n');
  });

  it('refuses an edge that would close a cycle', async () => {
    const env = await tempEnv();
    await runCommand(new AddCommand(), {blocker: 'A', blocked: 'B'}, env);
    await assert.rejects(
      runCommand(
        new SetCommand(),
        {node: 'A', direction: 'blockers', others: 'B'},
        env
      ),
      (err: unknown) => err instanceof DataError
    );
  });
});

describe('edge add', () => {
  it('refuses an edge that would close a cycle', async () => {
    const env = await tempEnv();
    await runCommand(new AddCommand(), {blocker: 'A', blocked: 'B'}, env);
    await assert.rejects(
      runCommand(new AddCommand(), {blocker: 'B', blocked: 'A'}, env),
      (err: unknown) => err instanceof DataError
    );
  });

  // Pins that the command calls `RefreshService.reconcile()`, not just its own
  // store write. An edge to an unwritten id leaves a placeholder node behind;
  // reconcile is the only thing that turns that into a `fetch_ticket` request.
  it('reconciles after writing, chasing the placeholder the new edge left behind', async () => {
    const env = await tempEnv();
    await withDatabase(undefined, env, async (db) => {
      await new ProjectStore(db).upsertProject({
        id: 'P',
        name: 'P',
        source: 'linear',
      });
      await new TicketStore(db).upsertTicket(ticket('T1', 'P'));
    });

    const output = await runCommand(
      new AddCommand(),
      {blocker: 'GONE', blocked: 'T1'},
      env
    );

    assert.equal(output, 'edge GONE -> T1 added=true\n');
    const openTickets = await withDatabase(undefined, env, (db) =>
      new FetchRequestStore(db).openTickets()
    );
    assert.deepEqual(
      openTickets.map((request) => request.ticket),
      ['GONE']
    );
  });
});

describe('edge rm', () => {
  it('removes an existing edge', async () => {
    const env = await tempEnv();
    await runCommand(new AddCommand(), {blocker: 'A', blocked: 'B'}, env);

    const output = await runCommand(
      new RmCommand(),
      {blocker: 'A', blocked: 'B'},
      env
    );

    assert.equal(output, 'removed edge A -> B existed=true\n');
    const edges = await withDatabase(undefined, env, (db) =>
      new EdgeStore(db).edges()
    );
    assert.deepEqual(edges, []);
  });

  it('reports existed=false for an edge that was never added', async () => {
    const env = await tempEnv();

    const output = await runCommand(
      new RmCommand(),
      {blocker: 'A', blocked: 'B'},
      env
    );

    assert.equal(output, 'removed edge A -> B existed=false\n');
  });
});
