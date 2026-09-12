import assert from 'node:assert/strict';
import {hostname} from 'node:os';
import {describe, it} from 'node:test';

import {runCommand, tempEnv, ticket} from '../../lib/command/test-support.mts';
import {withDatabase} from '../../lib/db/index.mts';
import {processStartIso} from '../../lib/liveness/index.mts';
import {
  CoordinationStore,
  ProjectStore,
  SessionStore,
  TicketStore,
  WorkerStore,
} from '../../lib/stores/index.mts';
import {Command} from './rm.mts';

const TURN = '2026-08-07T12:00:00.000Z';
const LATER = '2026-08-07T12:30:00.000Z';

async function launched(): Promise<NodeJS.ProcessEnv> {
  const env = {...(await tempEnv()), CLAUDE_CODE_SESSION_ID: 'claude-w'};
  await withDatabase(undefined, env, async (db) => {
    await new ProjectStore(db).upsertProject({
      id: 'P',
      name: 'P',
      source: 'linear',
    });
    await new TicketStore(db).upsertTicket(ticket('A', 'P'));
    await new SessionStore(db).register({
      id: 'S1',
      host: hostname(),
      pid: process.pid,
      claudeSessionId: 'claude-w',
      startedAt: processStartIso(),
      heartbeatAt: new Date().toISOString(),
    });
    await new CoordinationStore(db).claim({
      node: 'A',
      session: 'S1',
      claimedAt: TURN,
    });
    await new WorkerStore(db).set({
      node: 'A',
      session: 'S1',
      agentRef: 'agent-1',
      at: TURN,
    });
  });
  return env;
}

describe('worker rm', () => {
  it('hands the reported turn to cold recovery', async () => {
    const env = await launched();
    const out = await runCommand(new Command(), {node: 'A', turn: TURN}, env);
    assert.match(out, /removed=true/u);
    await withDatabase(undefined, env, async (db) => {
      assert.equal(await new WorkerStore(db).refFor('A', 'S1'), null);
      assert.deepEqual(await new CoordinationStore(db).claims(), []);
    });
  });

  it('leaves a later turn alone unless forced', async () => {
    const env = await launched();
    // A second relay re-claimed before the session got to the first agent's
    // return. Cleaning up on the stale turn would strand a working agent.
    await withDatabase(undefined, env, async (db) => {
      await new CoordinationStore(db).claim({
        node: 'A',
        session: 'S1',
        claimedAt: LATER,
      });
    });

    // The refusal has to say which one it is: an agent that reads "nothing
    // there" from a live turn being kept has no way to tell the two apart.
    const kept = await runCommand(new Command(), {node: 'A', turn: TURN}, env);
    assert.match(kept, /removed=false kept=not-this-turn/u);
    await withDatabase(undefined, env, async (db) => {
      assert.equal(await new WorkerStore(db).refFor('A', 'S1'), 'agent-1');
    });

    const forced = await runCommand(
      new Command(),
      {node: 'A', turn: TURN, force: true},
      env
    );
    assert.match(forced, /removed=true/u);

    const gone = await runCommand(new Command(), {node: 'A', turn: TURN}, env);
    assert.match(gone, /removed=false kept=no-address/u);
  });
});
