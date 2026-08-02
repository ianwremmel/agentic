import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {runCommand, tempEnv, ticket} from '../../lib/command/test-support.mts';
import {withDatabase} from '../../lib/db/index.mts';
import {
  EdgeStore,
  FetchRequestStore,
  MilestoneStore,
  ProjectStore,
  TicketStore,
} from '../../lib/stores/index.mts';
import {Command} from './set.mts';

describe('milestone set', () => {
  it('records the milestone under its project', async () => {
    const env = await tempEnv();
    await withDatabase(undefined, env, (db) =>
      new ProjectStore(db).upsertProject({id: 'P', name: 'P', source: 'linear'})
    );
    const out = await runCommand(
      new Command(),
      {id: 'M', project: 'P', name: 'Mile'},
      env
    );
    assert.equal(out, 'milestone M\n');
    const stored = await withDatabase(undefined, env, (db) =>
      new MilestoneStore(db).getMilestone('M')
    );
    assert.deepEqual(stored, {id: 'M', project: 'P', name: 'Mile'});
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

    await runCommand(new Command(), {id: 'M', project: 'P', name: 'Mile'}, env);

    const openTickets = await withDatabase(undefined, env, (db) =>
      new FetchRequestStore(db).openTickets()
    );
    assert.deepEqual(
      openTickets.map((request) => request.ticket),
      ['GONE']
    );
  });
});
