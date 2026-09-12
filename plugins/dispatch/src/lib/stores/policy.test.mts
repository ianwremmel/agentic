import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {Database} from '../db/database.mts';
import {DEFAULT_REPO_CAPS} from '../model/index.mts';
import {PolicyStore} from './policy.mts';

describe('PolicyStore', () => {
  it('reports the defaults until a server writes a policy', async () => {
    const db = await Database.open(':memory:');
    assert.deepEqual(
      await new PolicyStore(db).getRepoCaps(),
      DEFAULT_REPO_CAPS
    );
    await db.close();
  });

  it('round-trips the caps and their per-repo overrides', async () => {
    const db = await Database.open(':memory:');
    const store = new PolicyStore(db);
    const policy = {
      openPrs: 2,
      inFlightBuilds: 1,
      openPrsByRepo: {'o/a': 4},
      inFlightBuildsByRepo: {'o/b': 0},
    };
    await store.setRepoCaps(policy);
    assert.deepEqual(await store.getRepoCaps(), policy);

    // The last server to start owns the policy.
    await store.setRepoCaps({...policy, openPrs: 7});
    assert.equal((await store.getRepoCaps()).openPrs, 7);
    await db.close();
  });
});
