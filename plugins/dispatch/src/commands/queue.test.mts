import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {runCommand, tempEnv, ticket} from '../lib/command/test-support.mts';
import {withDatabase} from '../lib/db/index.mts';
import {EdgeStore, ProjectStore, TicketStore} from '../lib/stores/index.mts';
import {Command} from './queue.mts';

describe('queue', () => {
  it('prints dispatchable items in order and hides blocked ones', async () => {
    const env = await tempEnv();
    await withDatabase(undefined, env, async (db) => {
      await new ProjectStore(db).upsertProject({
        id: 'P',
        name: 'P',
        source: 'linear',
      });
      const tickets = new TicketStore(db);
      await tickets.upsertTicket(ticket('A', 'P'));
      await tickets.upsertTicket({...ticket('B', 'P'), injected: true});
      await tickets.upsertTicket(ticket('C', 'P'));
      await new EdgeStore(db).addEdge('A', 'C');
    });

    const out = await runCommand(new Command(), {}, env);
    assert.deepEqual(out.trimEnd().split('\n'), [
      'available B kind=ticket project=P injected',
      'available A kind=ticket project=P',
    ]);
  });

  it('says so when nothing is dispatchable', async () => {
    const env = await tempEnv();
    const out = await runCommand(new Command(), {}, env);
    assert.equal(out, 'queue empty\n');
  });
});
