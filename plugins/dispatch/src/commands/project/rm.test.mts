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
import {Command} from './rm.mts';

describe('project rm', () => {
  it('removes an existing project', async () => {
    const env = await tempEnv();
    await withDatabase(undefined, env, (db) =>
      new ProjectStore(db).upsertProject({id: 'P', name: 'P', source: 'linear'})
    );

    const out = await runCommand(new Command(), {id: 'P'}, env);

    assert.equal(out, 'removed project P existed=true\n');
    const stored = await withDatabase(undefined, env, (db) =>
      new ProjectStore(db).getProject('P')
    );
    assert.equal(stored, null);
  });

  it('reports existed=false for a project that was never declared', async () => {
    const env = await tempEnv();

    const out = await runCommand(new Command(), {id: 'NOPE'}, env);

    assert.equal(out, 'removed project NOPE existed=false\n');
  });

  // Pins that the command calls `RefreshService.reconcile()`, not just its own
  // store write. The fixture seeds a placeholder this call does not touch, so
  // only the reconcile pass can turn it into a `fetch_ticket` request.
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

    await runCommand(new Command(), {id: 'NOPE'}, env);

    const openTickets = await withDatabase(undefined, env, (db) =>
      new FetchRequestStore(db).openTickets()
    );
    assert.deepEqual(
      openTickets.map((request) => request.ticket),
      ['GONE']
    );
  });
});
