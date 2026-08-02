import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {describe, it} from 'node:test';

import {runCommand} from '../../lib/command/test-support.mts';
import {withDatabase} from '../../lib/db/index.mts';
import {TicketStore} from '../../lib/stores/index.mts';
import {Command} from './set.mts';

async function tempEnv(): Promise<NodeJS.ProcessEnv> {
  const dir = await mkdtemp(path.join(tmpdir(), 'dispatch-cmd-'));
  return {DISPATCH_DB: path.join(dir, 'graph.db')};
}

describe('ticket set', () => {
  it('records a ticket with its labels split and defaults applied', async () => {
    const env = await tempEnv();
    await runCommand(
      new Command(),
      {
        id: 'CLC-945',
        project: 'P',
        status: 'available',
        title: 'Do the thing',
        url: 'https://example.test/CLC-945',
        labels: 'infra,qa',
        'target-kind': 'pr',
      },
      env
    );
    const stored = await withDatabase(undefined, env, async (db) =>
      new TicketStore(db).getTicket('CLC-945')
    );
    assert.deepEqual(stored?.labels, ['infra', 'qa']);
    assert.equal(stored.targetKind, 'pr');
    assert.equal(stored.requiresHuman, false);
    assert.equal(stored.priority, null);
  });
});
