import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {describe, it} from 'node:test';

import {runCommand} from '../../lib/command/test-support.mts';
import {withDatabase} from '../../lib/db/index.mts';
import {ProjectStore} from '../../lib/stores/index.mts';
import {Command} from './rm.mts';

async function tempEnv(): Promise<NodeJS.ProcessEnv> {
  const dir = await mkdtemp(path.join(tmpdir(), 'dispatch-cmd-'));
  return {DISPATCH_DB: path.join(dir, 'graph.db')};
}

describe('project rm', () => {
  it('removes an existing project', async () => {
    const env = await tempEnv();
    await withDatabase(undefined, env, (db) =>
      new ProjectStore(db).upsertProject({id: 'P', name: 'P', source: 'linear'})
    );

    const out = await runCommand(new Command(), {id: 'P'}, env);

    assert.equal(out, 'removed project P existed=true\n');
    const stored = await withDatabase(undefined, env, (db) =>
      new ProjectStore(db).getProject('P')
    );
    assert.equal(stored, null);
  });

  it('reports existed=false for a project that was never declared', async () => {
    const env = await tempEnv();

    const out = await runCommand(new Command(), {id: 'NOPE'}, env);

    assert.equal(out, 'removed project NOPE existed=false\n');
  });
});
