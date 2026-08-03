import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {runCommand, tempEnv, ticket} from '../lib/command/test-support.mts';
import {withDatabase} from '../lib/db/index.mts';
import {
  EdgeStore,
  MilestoneStore,
  ProjectStore,
  TicketStore,
} from '../lib/stores/index.mts';
import {Command} from './status.mts';

describe('status', () => {
  it('prints counts, milestone gates, and the terminal verdict', async () => {
    const env = await tempEnv();
    await withDatabase(undefined, env, async (db) => {
      await new ProjectStore(db).upsertProject({
        id: 'P',
        name: 'P',
        source: 'linear',
      });
      await new MilestoneStore(db).upsertMilestone({
        id: 'M1',
        project: 'P',
        name: 'M1',
      });
      await new TicketStore(db).upsertTicket(ticket('A', 'P'));
      await new EdgeStore(db).addEdge('A', 'M1');
    });

    const out = await runCommand(new Command(), {}, env);
    assert.match(out, /^project P total=1 available=1 /mu);
    assert.match(
      out,
      /^milestone M1 project=P members=1 .*review-recorded=false/mu
    );
    assert.match(out, /^terminal=false$/mu);
  });
});
