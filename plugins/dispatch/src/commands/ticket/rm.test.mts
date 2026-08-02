import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {describe, it} from 'node:test';

import {runCommand} from '../../lib/command/test-support.mts';
import {withDatabase} from '../../lib/db/index.mts';
import {ProjectStore, TicketStore} from '../../lib/stores/index.mts';
import {Command} from './rm.mts';

async function tempEnv(): Promise<NodeJS.ProcessEnv> {
  const dir = await mkdtemp(path.join(tmpdir(), 'dispatch-cmd-'));
  return {DISPATCH_DB: path.join(dir, 'graph.db')};
}

describe('ticket rm', () => {
  it('removes an existing ticket', async () => {
    const env = await tempEnv();
    await withDatabase(undefined, env, async (db) => {
      await new ProjectStore(db).upsertProject({
        id: 'P',
        name: 'P',
        source: 'linear',
      });
      await new TicketStore(db).upsertTicket({
        id: 'T1',
        project: 'P',
        url: 'https://example.test/T1',
        title: 'T1',
        status: 'available',
        targetKind: 'pr',
        requiresHuman: false,
        injected: false,
        priority: null,
        branchHint: null,
        labels: [],
        updatedAt: null,
      });
    });

    const out = await runCommand(new Command(), {id: 'T1'}, env);

    assert.equal(out, 'removed ticket T1 existed=true\n');
    const stored = await withDatabase(undefined, env, (db) =>
      new TicketStore(db).getTicket('T1')
    );
    assert.equal(stored, null);
  });

  it('reports existed=false for a ticket that was never declared', async () => {
    const env = await tempEnv();

    const out = await runCommand(new Command(), {id: 'NOPE'}, env);

    assert.equal(out, 'removed ticket NOPE existed=false\n');
  });
});
