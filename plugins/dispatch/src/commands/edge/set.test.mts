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
import {Command} from './set.mts';

describe('edge set', () => {
  it('replaces every blocker of a node in one call', async () => {
    const env = await tempEnv();
    await withDatabase(undefined, env, (db) =>
      new EdgeStore(db).addEdge('OLD', 'N')
    );

    await runCommand(
      new Command(),
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
    await withDatabase(undefined, env, (db) =>
      new EdgeStore(db).addEdge('A', 'N')
    );

    const output = await runCommand(
      new Command(),
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
    await withDatabase(undefined, env, (db) =>
      new EdgeStore(db).addEdge('A', 'B')
    );

    await assert.rejects(
      runCommand(
        new Command(),
        {node: 'A', direction: 'blockers', others: 'B'},
        env
      ),
      (err: unknown) => err instanceof DataError
    );
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

    await runCommand(
      new Command(),
      {node: 'N', direction: 'blockers', others: ''},
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
});
