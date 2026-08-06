import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {runCommand, tempEnv, ticket} from '../../lib/command/test-support.mts';
import {withDatabase} from '../../lib/db/index.mts';
import {DataError} from '../../lib/errors/index.mts';
import {
  CoordinationStore,
  ProjectStore,
  SessionStore,
  TicketStore,
} from '../../lib/stores/index.mts';
import {Command} from './check.mts';

const NOW = '2026-08-06T12:00:00.000Z';
/** Older than the 300s staleness window, measured from real "now". */
const LONG_AGO = '2020-01-01T00:00:00.000Z';

async function fixture(
  env: NodeJS.ProcessEnv,
  opts: {claimBy?: string; heartbeat?: string} = {}
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
      startedAt: NOW,
      heartbeatAt: opts.heartbeat ?? new Date().toISOString(),
    });
    await sessions.register({
      id: 'S2',
      startedAt: NOW,
      heartbeatAt: new Date().toISOString(),
    });
    if (opts.claimBy !== undefined) {
      await new CoordinationStore(db).claim({
        node: 'A',
        session: opts.claimBy,
        claimedAt: NOW,
      });
    }
  });
}

describe('claim check', () => {
  it('passes when the scheduler claimed the node for this session', async () => {
    const env = await tempEnv();
    await fixture(env, {claimBy: 'S1'});
    const out = await runCommand(
      new Command(),
      {node: 'A', session: 'S1'},
      env
    );
    assert.equal(out, 'claim A S1\n');
  });

  it('refuses when nothing holds a claim', async () => {
    const env = await tempEnv();
    await fixture(env, {});
    // This is the self-directed launch: an agent started without a work
    // order, so no claim was ever taken and it spends no admission budget.
    await assert.rejects(
      runCommand(new Command(), {node: 'A', session: 'S1'}, env),
      (err: unknown) =>
        err instanceof DataError && err.message.includes('no claim is held')
    );
  });

  it('refuses when the claim belongs to another session', async () => {
    const env = await tempEnv();
    await fixture(env, {claimBy: 'S2'});
    await assert.rejects(
      runCommand(new Command(), {node: 'A', session: 'S1'}, env),
      (err: unknown) => err instanceof DataError && err.message.includes('S2')
    );
  });

  it('refuses when the claiming session stopped heartbeating', async () => {
    const env = await tempEnv();
    await fixture(env, {claimBy: 'S1', heartbeat: LONG_AGO});
    // The sweep is about to cascade this claim and re-dispatch the node.
    // Running on it would put two workers on one node.
    await assert.rejects(
      runCommand(new Command(), {node: 'A', session: 'S1'}, env),
      (err: unknown) =>
        err instanceof DataError && err.message.includes('heartbeating')
    );
  });

  it('refuses when no server correlates to the caller at all', async () => {
    const env = await tempEnv();
    await fixture(env, {claimBy: 'S1'});
    // No --session and no CLAUDE_CODE_SESSION_ID: nothing dispatched this.
    await assert.rejects(
      runCommand(new Command(), {node: 'A'}, env),
      (err: unknown) =>
        err instanceof DataError && err.message.includes('no live server')
    );
  });
});
