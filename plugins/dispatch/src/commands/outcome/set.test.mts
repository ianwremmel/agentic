import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {runCommand, tempEnv, ticket} from '../../lib/command/test-support.mts';
import {withDatabase} from '../../lib/db/index.mts';
import {
  CoordinationStore,
  ProjectStore,
  SessionStore,
  TicketStore,
} from '../../lib/stores/index.mts';
import {Command} from './set.mts';

const NOW = '2026-08-03T12:00:00.000Z';

describe('outcome set', () => {
  it('records the outcome and releases the claim', async () => {
    const env = await tempEnv();
    await withDatabase(undefined, env, async (db) => {
      await new ProjectStore(db).upsertProject({
        id: 'P',
        name: 'P',
        source: 'linear',
      });
      await new TicketStore(db).upsertTicket(ticket('A', 'P'));
      await new SessionStore(db).register({
        id: 'S1',
        startedAt: NOW,
        heartbeatAt: NOW,
      });
      await new CoordinationStore(db).claim({
        node: 'A',
        session: 'S1',
        claimedAt: NOW,
      });
    });

    const out = await runCommand(
      new Command(),
      {id: 'A', outcome: 'delivered', session: 'S1'},
      env
    );
    assert.equal(out, 'outcome A delivered\n');

    await withDatabase(undefined, env, async (db) => {
      const coordination = new CoordinationStore(db);
      assert.equal((await coordination.getOutcome('A'))?.outcome, 'delivered');
      assert.deepEqual(await coordination.claims(), []);
    });
  });

  it('drops a non-failure retryable flag instead of refusing the report', async () => {
    const env = await tempEnv();
    await withDatabase(undefined, env, async (db) => {
      await new ProjectStore(db).upsertProject({
        id: 'P',
        name: 'P',
        source: 'linear',
      });
      await new TicketStore(db).upsertTicket(ticket('A', 'P'));
    });

    const out = await runCommand(
      new Command(),
      {id: 'A', outcome: 'verified'},
      env
    );
    assert.equal(out, 'outcome A verified\n');
  });

  it('records the outcome when no claim is held at all', async () => {
    const env = await tempEnv();
    await withDatabase(undefined, env, async (db) => {
      await new ProjectStore(db).upsertProject({
        id: 'P',
        name: 'P',
        source: 'linear',
      });
      await new TicketStore(db).upsertTicket(ticket('A', 'P'));
    });

    // The claim was swept with its session before the worker reported. The
    // report must still land: the outcome is what re-admits the node.
    await runCommand(new Command(), {id: 'A', outcome: 'delivered'}, env);

    await withDatabase(undefined, env, async (db) => {
      assert.equal(
        (await new CoordinationStore(db).getOutcome('A'))?.outcome,
        'delivered'
      );
    });
  });

  it('leaves a live claim alone when a swept worker reports late', async () => {
    const env = await tempEnv();
    await withDatabase(undefined, env, async (db) => {
      await new ProjectStore(db).upsertProject({
        id: 'P',
        name: 'P',
        source: 'linear',
      });
      await new TicketStore(db).upsertTicket(ticket('A', 'P'));
      const sessions = new SessionStore(db);
      await sessions.register({id: 'S1', startedAt: NOW, heartbeatAt: NOW});
      await sessions.register({id: 'S2', startedAt: NOW, heartbeatAt: NOW});
      // S1's claim was swept; S2 picked the node back up and is running it.
      await new CoordinationStore(db).claim({
        node: 'A',
        session: 'S2',
        claimedAt: NOW,
      });
    });

    // S1 reports late. The outcome lands, but S2's grant must survive —
    // deleting it would leave a running agent with no claim, and the node
    // would be handed to a third worker.
    await runCommand(
      new Command(),
      {id: 'A', outcome: 'failed', session: 'S1'},
      env
    );

    await withDatabase(undefined, env, async (db) => {
      const coordination = new CoordinationStore(db);
      assert.equal((await coordination.getOutcome('A'))?.outcome, 'failed');
      assert.deepEqual(await coordination.claims(), [
        {node: 'A', session: 'S2', actor: null},
      ]);
    });
  });
});
