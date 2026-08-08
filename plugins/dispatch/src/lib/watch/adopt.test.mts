import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {tempEnv, ticket} from '../command/test-support.mts';
import {withDatabase} from '../db/index.mts';
import {nowIso} from '../db/time.mts';
import {ProjectStore, PrStore, TicketStore} from '../stores/index.mts';
import {adoptOrphans} from './adopt.mts';

async function fixture(env: NodeJS.ProcessEnv): Promise<void> {
  await withDatabase(undefined, env, async (db) => {
    await new ProjectStore(db).upsertProject({
      id: 'P',
      name: 'P',
      source: 'linear',
    });
    await new TicketStore(db).upsertTicket(ticket('CLC-9', 'P'));
    // One known item is what puts the repo in scope for adoption at all.
    await new PrStore(db).upsertPr({
      id: 'o/r#known-branch',
      ticket: null,
      origin: 'prompt',
      repo: 'o/r',
      prNumber: 1,
      url: null,
      branch: 'known-branch',
      title: 'known',
      injected: false,
      priority: null,
      updatedAt: nowIso(),
    });
  });
}

describe('adoptOrphans', () => {
  it('adopts an unknown PR and links the ticket its branch names', async () => {
    const env = await tempEnv();
    await fixture(env);
    const adopted = await adoptOrphans(env, {
      list: () =>
        Promise.resolve([
          {number: 7, headRefName: 'clc-9-do-the-thing'},
          {number: 1, headRefName: 'known-branch'},
        ]),
    });
    assert.equal(adopted, 1);
    await withDatabase(undefined, env, async (db) => {
      const pr = await new PrStore(db).getPr('o/r#clc-9-do-the-thing');
      assert.ok(pr !== null);
      assert.equal(pr.origin, 'adopted');
      assert.equal(pr.ticket, 'CLC-9');
      assert.equal(pr.prNumber, 7);
    });
  });

  it('adopts a branch with no known ticket as bare work', async () => {
    const env = await tempEnv();
    await fixture(env);
    await adoptOrphans(env, {
      list: () => Promise.resolve([{number: 8, headRefName: 'fix/oneoff'}]),
    });
    await withDatabase(undefined, env, async (db) => {
      assert.equal(
        (await new PrStore(db).getPr('o/r#fix/oneoff'))?.ticket,
        null
      );
    });
  });

  it('adopts nothing twice and survives a listing failure', async () => {
    const env = await tempEnv();
    await fixture(env);
    const lister = () => Promise.resolve([{number: 7, headRefName: 'clc-9-x'}]);
    assert.equal(await adoptOrphans(env, {list: lister}), 1);
    // Second sweep: the branch is known now; nothing re-adopts.
    assert.equal(await adoptOrphans(env, {list: lister}), 0);
    // A failing repo listing costs that repo, not the sweep.
    assert.equal(
      await adoptOrphans(env, {
        list: () => Promise.reject(new Error('gh down')),
      }),
      0
    );
  });
});
