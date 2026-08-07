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
import {Command} from './status.mts';

const NOW = '2026-08-06T12:00:00.000Z';

describe('claim status', () => {
  it('counts only claims whose session still heartbeats', async () => {
    const env = await tempEnv();
    await withDatabase(undefined, env, async (db) => {
      await new ProjectStore(db).upsertProject({
        id: 'P',
        name: 'P',
        source: 'linear',
      });
      const tickets = new TicketStore(db);
      await tickets.upsertTicket(ticket('A', 'P'));
      await tickets.upsertTicket(ticket('B', 'P'));
      const sessions = new SessionStore(db);
      await sessions.register({
        id: 'LIVE',
        startedAt: NOW,
        heartbeatAt: new Date().toISOString(),
      });
      await sessions.register({
        id: 'DEAD',
        startedAt: NOW,
        heartbeatAt: '2020-01-01T00:00:00.000Z',
      });
      const coordination = new CoordinationStore(db);
      await coordination.claim({node: 'A', session: 'LIVE', claimedAt: NOW});
      await coordination.claim({node: 'B', session: 'DEAD', claimedAt: NOW});
    });

    // A supervisor deciding whether cycling costs an in-flight worker must
    // not be held off by a claim nobody is meeting.
    const out = await runCommand(new Command(), {}, env);
    assert.match(out, /^claims held=1$/mu);
    assert.match(out, /claim A session=LIVE/u);
    // The listing must agree with the count: printing the dead session's
    // claim would contradict the header a supervisor parses.
    assert.doesNotMatch(out, /DEAD/u);
  });

  it('reports zero on an empty graph', async () => {
    const env = await tempEnv();
    assert.equal(await runCommand(new Command(), {}, env), 'claims held=0\n');
  });
});
