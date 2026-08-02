import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {describe, it} from 'node:test';

import {runCommand} from '../../lib/command/test-support.mts';
import {withDatabase} from '../../lib/db/index.mts';
import {ProjectStore} from '../../lib/stores/index.mts';
import {Command} from './set.mts';

async function tempEnv(): Promise<NodeJS.ProcessEnv> {
  const dir = await mkdtemp(path.join(tmpdir(), 'dispatch-cmd-'));
  return {DISPATCH_DB: path.join(dir, 'graph.db')};
}

describe('project set', () => {
  it('records the project with its tracker', async () => {
    const env = await tempEnv();
    const out = await runCommand(
      new Command(),
      {id: 'P', name: 'Proj', tracker: 'linear'},
      env
    );
    assert.equal(out, 'project P\n');
    const stored = await withDatabase(undefined, env, async (db) =>
      new ProjectStore(db).getProject('P')
    );
    assert.deepEqual(stored, {id: 'P', name: 'Proj', source: 'linear'});
  });
});
