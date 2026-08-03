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
  it('records the outcome and releases the claim and slot', async () => {
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
      const coordination = new CoordinationStore(db);
      await coordination.claim({node: 'A', session: 'S1', claimedAt: NOW});
      await coordination.acquireSlot({
        session: 'S1',
        actor: 'worker-A',
        max: 3,
        acquiredAt: NOW,
      });
    });

    const out = await runCommand(
      new Command(),
      {id: 'A', outcome: 'delivered', actor: 'worker-A'},
      env
    );
    assert.equal(out, 'outcome A delivered\n');

    await withDatabase(undefined, env, async (db) => {
      const coordination = new CoordinationStore(db);
      assert.equal((await coordination.getOutcome('A'))?.outcome, 'delivered');
      assert.deepEqual(await coordination.claims(), []);
      assert.equal(await coordination.slotCount(), 0);
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

  it('releases the slot even when the claim is already gone', async () => {
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
      await new CoordinationStore(db).acquireSlot({
        session: 'S1',
        actor: 'worker-A',
        max: 3,
        acquiredAt: NOW,
      });
    });

    await runCommand(
      new Command(),
      {id: 'A', outcome: 'delivered', actor: 'worker-A'},
      env
    );

    await withDatabase(undefined, env, async (db) => {
      assert.equal(await new CoordinationStore(db).slotCount(), 0);
    });
  });
});
