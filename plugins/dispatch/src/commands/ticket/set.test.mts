import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {describe, it} from 'node:test';

import {runCommand} from '../../lib/command/test-support.mts';
import {withDatabase} from '../../lib/db/index.mts';
import type {Ticket} from '../../lib/model/index.mts';
import {
  EdgeStore,
  FetchRequestStore,
  ProjectStore,
  TicketStore,
} from '../../lib/stores/index.mts';
import {Command} from './set.mts';

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

describe('ticket set', () => {
  it('records a ticket with its labels split and defaults applied', async () => {
    const env = await tempEnv();
    await runCommand(
      new Command(),
      {
        id: 'CLC-945',
        project: 'P',
        status: 'available',
        title: 'Do the thing',
        url: 'https://example.test/CLC-945',
        labels: 'infra,qa',
        'target-kind': 'pr',
      },
      env
    );
    const stored = await withDatabase(undefined, env, async (db) =>
      new TicketStore(db).getTicket('CLC-945')
    );
    assert.deepEqual(stored?.labels, ['infra', 'qa']);
    assert.equal(stored.targetKind, 'pr');
    assert.equal(stored.requiresHuman, false);
    assert.equal(stored.priority, null);
  });

  // Pins that the command calls `RefreshService.reconcile()`, not just its own
  // store write. A fresh database gives reconcile nothing to do, so the
  // fixture seeds a placeholder (`GONE`) that a resolvable tracker can chase —
  // reconcile is the only thing that turns that into a `fetch_ticket` request.
  it('reconciles after writing, chasing a placeholder left by other state', async () => {
    const env = await tempEnv();
    await withDatabase(undefined, env, async (db) => {
      await new ProjectStore(db).upsertProject({
        id: 'P',
        name: 'P',
        source: 'linear',
      });
      await new TicketStore(db).upsertTicket(ticket('T1', 'P'));
      await new EdgeStore(db).addEdge('GONE', 'T1');
    });

    await runCommand(
      new Command(),
      {id: 'T2', project: 'P', status: 'available'},
      env
    );

    const openTickets = await withDatabase(undefined, env, (db) =>
      new FetchRequestStore(db).openTickets()
    );
    assert.deepEqual(
      openTickets.map((request) => request.ticket),
      ['GONE']
    );
  });

  it('applies the pr default when --target-kind is omitted', async () => {
    const env = await tempEnv();

    await runCommand(
      new Command(),
      {id: 'T3', project: 'P', status: 'available'},
      env
    );

    const stored = await withDatabase(undefined, env, (db) =>
      new TicketStore(db).getTicket('T3')
    );
    assert.equal(stored?.targetKind, 'pr');
  });
});
