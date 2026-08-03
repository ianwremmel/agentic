import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {runCommand, tempEnv} from '../../lib/command/test-support.mts';
import {withDatabase} from '../../lib/db/index.mts';
import {UsageError} from '../../lib/errors/index.mts';
import {
  EdgeStore,
  ProjectStore,
  RefreshStore,
  TicketStore,
} from '../../lib/stores/index.mts';
import {RefreshService} from '../../lib/refresh/index.mts';
import {Command} from './missing.mts';

describe('ticket missing', () => {
  it('closes the refresh once the last requested id is reported missing', async () => {
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
        url: 'u',
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
      await new EdgeStore(db).addEdge('GONE', 'T1');
      await new RefreshService(db).reconcile();
    });

    await runCommand(new Command(), {id: 'GONE'}, env);

    const state = await withDatabase(undefined, env, async (db) =>
      new RefreshStore(db).get('linear')
    );
    assert.equal(state?.state, 'idle');
  });

  it('refuses an id nobody asked for', async () => {
    const env = await tempEnv();
    await assert.rejects(
      runCommand(new Command(), {id: 'NOPE'}, env),
      (err: unknown) => err instanceof UsageError
    );
  });
});
