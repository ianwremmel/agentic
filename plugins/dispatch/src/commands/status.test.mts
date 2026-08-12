import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {runCommand, tempEnv, ticket} from '../lib/command/test-support.mts';
import {withDatabase} from '../lib/db/index.mts';
import {
  EdgeStore,
  MilestoneStore,
  PolicyStore,
  PrStore,
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

  it('names the cap holding queued work back', async () => {
    const env = await tempEnv();
    await withDatabase(undefined, env, async (db) => {
      await new PolicyStore(db).setRepoCaps({
        openPrs: 1,
        inFlightBuilds: 9,
        openPrsByRepo: {},
        inFlightBuildsByRepo: {},
      });
      const prs = new PrStore(db);
      for (const [id, prNumber] of [
        ['o/r#7', 7],
        ['o/r#new', null],
      ] as const) {
        await prs.upsertPr({
          id,
          ticket: null,
          origin: 'prompt',
          repo: 'o/r',
          prNumber,
          url: null,
          branch: null,
          title: id,
          injected: false,
          priority: null,
          updatedAt: null,
        });
      }
    });

    const out = await runCommand(new Command(), {}, env);
    assert.match(out, /^cap-hold o\/r open-prs=1\/1 waiting=1$/mu);
  });
});
