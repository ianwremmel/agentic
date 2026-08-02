import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {describe, it} from 'node:test';

import {runCommand} from '../../lib/command/test-support.mts';
import {withDatabase} from '../../lib/db/index.mts';
import {MilestoneStore, ProjectStore} from '../../lib/stores/index.mts';
import {Command} from './rm.mts';

async function tempEnv(): Promise<NodeJS.ProcessEnv> {
  const dir = await mkdtemp(path.join(tmpdir(), 'dispatch-cmd-'));
  return {DISPATCH_DB: path.join(dir, 'graph.db')};
}

describe('milestone rm', () => {
  it('removes an existing milestone', async () => {
    const env = await tempEnv();
    await withDatabase(undefined, env, async (db) => {
      await new ProjectStore(db).upsertProject({
        id: 'P',
        name: 'P',
        source: 'linear',
      });
      await new MilestoneStore(db).upsertMilestone({
        id: 'M',
        project: 'P',
        name: 'Mile',
      });
    });

    const out = await runCommand(new Command(), {id: 'M'}, env);

    assert.equal(out, 'removed milestone M existed=true\n');
    const stored = await withDatabase(undefined, env, (db) =>
      new MilestoneStore(db).getMilestone('M')
    );
    assert.equal(stored, null);
  });

  it('reports existed=false for a milestone that was never declared', async () => {
    const env = await tempEnv();

    const out = await runCommand(new Command(), {id: 'NOPE'}, env);

    assert.equal(out, 'removed milestone NOPE existed=false\n');
  });
});
