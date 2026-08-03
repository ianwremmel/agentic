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

describe('edge rm', () => {
  it('removes an existing edge', async () => {
    const env = await tempEnv();
    await withDatabase(undefined, env, (db) =>
      new EdgeStore(db).addEdge('A', 'B')
    );

    const output = await runCommand(
      new Command(),
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
      new Command(),
      {blocker: 'A', blocked: 'B'},
      env
    );

    assert.equal(output, 'removed edge A -> B existed=false\n');
  });

  // Pins that the command calls `RefreshService.reconcile()`, not just its own
  // store write. Removing an edge can leave the graph owing a fetch it was not
  // owing before, so the pass has to run here too; the fixture seeds a
  // placeholder this command does not touch, which only reconcile chases.
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

    await runCommand(new Command(), {blocker: 'X', blocked: 'Y'}, env);

    const openTickets = await withDatabase(undefined, env, (db) =>
      new FetchRequestStore(db).openTickets()
    );
    assert.deepEqual(
      openTickets.map((request) => request.ticket),
      ['GONE']
    );
  });
});
