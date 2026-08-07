import assert from 'node:assert/strict';
import {hostname} from 'node:os';
import {describe, it} from 'node:test';

import {runCommand, tempEnv, ticket} from '../../lib/command/test-support.mts';
import {withDatabase} from '../../lib/db/index.mts';
import {DataError} from '../../lib/errors/index.mts';
import {processStartIso} from '../../lib/liveness/index.mts';
import {
  CoordinationStore,
  ProjectStore,
  SessionStore,
  TicketStore,
} from '../../lib/stores/index.mts';
import {Command} from './set.mts';

const NOW = '2026-08-07T12:00:00.000Z';
const CALLER = 'claude-caller';

/**
 * S1 carries the caller's Claude session id, so correlation — not a flag —
 * is what identifies it. S2 is a different session this caller must never be
 * able to speak for.
 */
async function fixture(
  env: NodeJS.ProcessEnv,
  claimBy?: string
): Promise<void> {
  await withDatabase(undefined, env, async (db) => {
    await new ProjectStore(db).upsertProject({
      id: 'P',
      name: 'P',
      source: 'linear',
    });
    await new TicketStore(db).upsertTicket(ticket('A', 'P'));
    const sessions = new SessionStore(db);
    await sessions.register({
      id: 'S1',
      host: hostname(),
      pid: process.pid,
      claudeSessionId: CALLER,
      startedAt: processStartIso(),
      heartbeatAt: new Date().toISOString(),
    });
    await sessions.register({
      id: 'S2',
      host: hostname(),
      pid: process.pid,
      claudeSessionId: 'claude-other',
      startedAt: processStartIso(),
      heartbeatAt: new Date().toISOString(),
    });
    if (claimBy !== undefined) {
      await new CoordinationStore(db).claim({
        node: 'A',
        session: claimBy,
        claimedAt: NOW,
      });
    }
  });
}

async function callerEnv(): Promise<NodeJS.ProcessEnv> {
  return {...(await tempEnv()), CLAUDE_CODE_SESSION_ID: CALLER};
}

describe('outcome set', () => {
  it('records the outcome and releases the claim', async () => {
    const env = await callerEnv();
    await fixture(env, 'S1');

    const out = await runCommand(
      new Command(),
      {id: 'A', outcome: 'delivered'},
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
    const env = await callerEnv();
    await fixture(env, 'S1');
    const out = await runCommand(
      new Command(),
      {id: 'A', outcome: 'verified', retryable: true},
      env
    );
    assert.equal(out, 'outcome A verified\n');
  });

  it('refuses a report from a worker that holds no claim', async () => {
    const env = await callerEnv();
    await fixture(env);

    // The CLC-1049 case: a self-directed worker the claim guard turned away
    // recorded `failed`, which is non-retryable, so the ticket left the queue
    // permanently and nothing re-served it.
    await assert.rejects(
      runCommand(new Command(), {id: 'A', outcome: 'failed'}, env),
      (err: unknown) =>
        err instanceof DataError && err.message.includes('holds no claim')
    );

    await withDatabase(undefined, env, async (db) => {
      assert.equal(await new CoordinationStore(db).getOutcome('A'), null);
    });
  });

  it('refuses a late report while another session works the node', async () => {
    const env = await callerEnv();
    await fixture(env, 'S2');

    // This caller's claim was swept and S2 picked the node back up. Recording
    // would mark it terminal underneath a live worker, whose own report would
    // then overwrite it.
    await assert.rejects(
      runCommand(new Command(), {id: 'A', outcome: 'delivered'}, env),
      (err: unknown) => err instanceof DataError
    );

    await withDatabase(undefined, env, async (db) => {
      const coordination = new CoordinationStore(db);
      assert.equal(await coordination.getOutcome('A'), null);
      assert.deepEqual(await coordination.claims(), [
        {node: 'A', session: 'S2', actor: null},
      ]);
    });
  });

  it('refuses a caller the environment cannot identify', async () => {
    const withId = await callerEnv();
    await fixture(withId, 'S1');

    // A worker whose server died, or whose environment carries no session id,
    // is indistinguishable from an operator here — so it gets no authority.
    // Treating it as one would leave the guard bypassable exactly when the
    // system is unhealthy, which is when it matters most.
    const anonymous = {...withId, CLAUDE_CODE_SESSION_ID: undefined};
    await assert.rejects(
      runCommand(new Command(), {id: 'A', outcome: 'failed'}, anonymous),
      (err: unknown) => err instanceof DataError
    );

    await withDatabase(undefined, withId, async (db) => {
      assert.equal(await new CoordinationStore(db).getOutcome('A'), null);
    });
  });

  it('lets an operator resolve a node by hand with --force', async () => {
    const env = await callerEnv();
    await fixture(env);

    // The escape hatch is explicit and named, not inferred from an ambiguous
    // condition. A dispatched worker holds its claim and never needs it, and
    // the refusal above never mentions it.
    const out = await runCommand(
      new Command(),
      {id: 'A', outcome: 'canceled', force: true},
      env
    );
    assert.equal(out, 'outcome A canceled\n');

    await withDatabase(undefined, env, async (db) => {
      assert.equal(
        (await new CoordinationStore(db).getOutcome('A'))?.outcome,
        'canceled'
      );
    });
  });
});
