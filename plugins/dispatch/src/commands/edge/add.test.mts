import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {runCommand, tempEnv, ticket} from '../../lib/command/test-support.mts';
import {withDatabase} from '../../lib/db/index.mts';
import {DataError} from '../../lib/errors/index.mts';
import {
  EdgeStore,
  FetchRequestStore,
  ProjectStore,
  TicketStore,
} from '../../lib/stores/index.mts';
import {Command} from './add.mts';

describe('edge add', () => {
  it('records the edge', async () => {
    const env = await tempEnv();

    const output = await runCommand(
      new Command(),
      {blocker: 'A', blocked: 'B'},
      env
    );

    assert.equal(output, 'edge A -> B added=true\n');
    const edges = await withDatabase(undefined, env, (db) =>
      new EdgeStore(db).edges()
    );
    assert.deepEqual(edges, [{blocker: 'A', blocked: 'B'}]);
  });

  it('refuses an edge that would close a cycle', async () => {
    const env = await tempEnv();
    await runCommand(new Command(), {blocker: 'A', blocked: 'B'}, env);
    await assert.rejects(
      runCommand(new Command(), {blocker: 'B', blocked: 'A'}, env),
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
      new Command(),
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
