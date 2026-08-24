import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {runCommand, tempEnv, ticket} from '../../lib/command/test-support.mts';
import {withDatabase} from '../../lib/db/index.mts';
import {
  EdgeStore,
  FetchRequestStore,
  ProjectStore,
  TicketStore,
} from '../../lib/stores/index.mts';
import {Command} from './set.mts';

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

  // Pins the answer half of the refresh cadence through the command path: the
  // scheduler's ask is resolved by the UPDATE inside `upsertTicket`'s
  // transaction, and a resolved ask is invisible to the stale sweep. If either
  // side regresses, the channel re-issues the same ask every ten minutes
  // forever.
  it('resolves a delivered refresh ask so the stale sweep cannot re-issue it', async () => {
    const env = await tempEnv();
    const askedAt = '2026-08-23T12:00:00.000Z';
    const deliveredAt = '2026-08-23T12:00:05.000Z';
    // Far past the ten-minute stale window.
    const muchLater = '2026-08-23T13:00:00.000Z';

    // A refresh ask the server pushed and marked delivered, as the scheduler
    // and drain leave it while waiting on the session's answer.
    await withDatabase(undefined, env, async (db) => {
      await new ProjectStore(db).upsertProject({
        id: 'P',
        name: 'P',
        source: 'linear',
      });
      await new TicketStore(db).upsertTicket({
        ...ticket('CLC-945', 'P'),
        status: 'in-progress',
      });
      const requests = new FetchRequestStore(db);
      const id = await requests.enqueueTicketRefresh({
        source: 'linear',
        ticket: 'CLC-945',
        at: askedAt,
      });
      assert.ok(id !== null, 'the ask must enqueue');
      await requests.markDelivered(id, deliveredAt);
    });

    await runCommand(
      new Command(),
      {id: 'CLC-945', project: 'P', status: 'in-progress'},
      env
    );

    await withDatabase(undefined, env, async (db) => {
      const requests = new FetchRequestStore(db);
      const open = await requests.openTicketRequest('CLC-945');
      assert.equal(open, null, 'the delivered ask must be resolved by the set');
      const reoffered = await requests.redeliverStaleTicketRefreshes(
        muchLater,
        600
      );
      assert.equal(reoffered, 0, 'a resolved ask must not be re-offered');
    });
  });
});
