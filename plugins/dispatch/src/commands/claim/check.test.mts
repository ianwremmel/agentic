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
import {hostname} from 'node:os';

import {processStartIso} from '../../lib/liveness/index.mts';
import {Command} from './check.mts';

const NOW = '2026-08-06T12:00:00.000Z';
/** Older than the 300s staleness window, measured from real "now". */
const LONG_AGO = '2020-01-01T00:00:00.000Z';

/**
 * Register S1 carrying the caller's Claude session id, so correlation — not
 * an asserted `--session` — is what identifies it. S2 is a different session
 * that this caller must never be able to speak for.
 */
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
      host: hostname(),
      pid: process.pid,
      claudeSessionId: 'claude-caller',
      startedAt: processStartIso(),
      heartbeatAt: opts.heartbeat ?? new Date().toISOString(),
    });
    await sessions.register({
      id: 'S2',
      host: hostname(),
      pid: process.pid,
      claudeSessionId: 'claude-other',
      startedAt: processStartIso(),
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
    const env = {...(await tempEnv()), CLAUDE_CODE_SESSION_ID: 'claude-caller'};
    await fixture(env, {claimBy: 'S1'});
    const out = await runCommand(new Command(), {node: 'A'}, env);
    assert.equal(out, 'claim A S1\n');
  });

  it('refuses when nothing holds a claim', async () => {
    const env = {...(await tempEnv()), CLAUDE_CODE_SESSION_ID: 'claude-caller'};
    await fixture(env, {});
    // This is the self-directed launch: an agent started without a work
    // order, so no claim was ever taken and it spends no admission budget.
    await assert.rejects(
      runCommand(new Command(), {node: 'A'}, env),
      (err: unknown) =>
        err instanceof DataError && err.message.includes('no claim is held')
    );
  });

  it('refuses when the claim belongs to another session', async () => {
    const env = {...(await tempEnv()), CLAUDE_CODE_SESSION_ID: 'claude-caller'};
    await fixture(env, {claimBy: 'S2'});
    await assert.rejects(
      runCommand(new Command(), {node: 'A'}, env),
      (err: unknown) => err instanceof DataError && err.message.includes('S2')
    );
  });

  it('refuses when the claiming session stopped heartbeating', async () => {
    const env = {...(await tempEnv()), CLAUDE_CODE_SESSION_ID: 'claude-caller'};
    await fixture(env, {claimBy: 'S1', heartbeat: LONG_AGO});
    // Correlation itself rejects a session whose heartbeat lapsed, so a
    // worker whose server died cannot prove authority from its claim. The
    // sweep is about to cascade that claim and re-dispatch the node;
    // continuing would put two workers on it.
    await assert.rejects(
      runCommand(new Command(), {node: 'A'}, env),
      (err: unknown) =>
        err instanceof DataError && err.message.includes('no live server')
    );
  });

  it('refuses a caller the environment cannot identify', async () => {
    const withId = {
      ...(await tempEnv()),
      CLAUDE_CODE_SESSION_ID: 'claude-caller',
    };
    await fixture(withId, {claimBy: 'S1'});
    // Same database, same live claim — but this caller carries no session id,
    // so nothing ties it to the holder.
    const anonymous = {...withId, CLAUDE_CODE_SESSION_ID: undefined};
    await assert.rejects(
      runCommand(new Command(), {node: 'A'}, anonymous),
      (err: unknown) =>
        err instanceof DataError && err.message.includes('no live server')
    );
  });

  it('cannot be satisfied by naming the holder', async () => {
    const withId = {
      ...(await tempEnv()),
      CLAUDE_CODE_SESSION_ID: 'claude-caller',
    };
    await fixture(withId, {claimBy: 'S1'});
    // The holder's id is public — `dispatch claim status` prints it — so if
    // asserting it were enough, every unclaimed worker could pass by reading
    // it off. There is no flag to assert one: identity comes from the
    // environment, which the caller does not choose.
    const other = {...withId, CLAUDE_CODE_SESSION_ID: 'claude-other'};
    await assert.rejects(
      runCommand(new Command(), {node: 'A'}, other),
      (err: unknown) => err instanceof DataError
    );
  });
});
