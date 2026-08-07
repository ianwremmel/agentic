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
  WorkerStore,
} from '../../lib/stores/index.mts';
import {Command} from './set.mts';

describe('worker set', () => {
  it('records the address under the correlated session', async () => {
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
        claimedAt: new Date().toISOString(),
      });
    });

    await runCommand(new Command(), {node: 'A', agent: 'agent-1'}, env);

    await withDatabase(undefined, env, async (db) => {
      assert.equal(await new WorkerStore(db).refFor('A', 'S1'), 'agent-1');
    });
  });

  it('refuses a caller the environment cannot identify', async () => {
    const env = await tempEnv();
    await withDatabase(undefined, env, async (db) => {
      await new ProjectStore(db).upsertProject({
        id: 'P',
        name: 'P',
        source: 'linear',
      });
      await new TicketStore(db).upsertTicket(ticket('A', 'P'));
    });
    // An address only the launcher can use is meaningless recorded by anyone
    // else.
    await assert.rejects(
      runCommand(new Command(), {node: 'A', agent: 'agent-1'}, env),
      (err: unknown) => err instanceof DataError
    );
  });
});
