import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {tempEnv, ticket} from '../command/test-support.mts';
import {withDatabase} from '../db/index.mts';
import {nowIso} from '../db/time.mts';
import {
  CoordinationStore,
  ProjectStore,
  PrStore,
  TicketStore,
} from '../stores/index.mts';
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
      id: 'o/r#1',
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
      const pr = await new PrStore(db).getPr('o/r#7');
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
      assert.equal((await new PrStore(db).getPr('o/r#8'))?.ticket, null);
    });
  });

  it('adopts nothing twice and survives a listing failure', async () => {
    const env = await tempEnv();
    await fixture(env);
    const lister = () => Promise.resolve([{number: 7, headRefName: 'clc-9-x'}]);
    assert.equal(await adoptOrphans(env, {list: lister}), 1);
    // Second sweep: the number is known now; nothing re-adopts.
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

describe('adoptOrphans identity and dispatch', () => {
  it('keys on the PR number so a shared head name does not collide', async () => {
    const env = await tempEnv();
    await fixture(env);
    // Two open PRs with the same head ref (forks): both must register, under
    // distinct number-keyed ids, not overwrite each other.
    const adopted = await adoptOrphans(env, {
      list: () =>
        Promise.resolve([
          {number: 10, headRefName: 'shared'},
          {number: 11, headRefName: 'shared'},
        ]),
    });
    assert.equal(adopted, 2);
    await withDatabase(undefined, env, async (db) => {
      assert.ok((await new PrStore(db).getPr('o/r#10')) !== null);
      assert.ok((await new PrStore(db).getPr('o/r#11')) !== null);
    });
  });

  it("adopts a fork PR that reuses a numbered item's head name", async () => {
    const env = await tempEnv();
    await fixture(env);
    // The fixture item o/r#1 is numbered and lives on branch 'known-branch'.
    // A distinct fork PR on the same head name is its own work: the numbered
    // row's branch must not suppress it.
    const adopted = await adoptOrphans(env, {
      list: () => Promise.resolve([{number: 99, headRefName: 'known-branch'}]),
    });
    assert.equal(adopted, 1);
    await withDatabase(undefined, env, async (db) => {
      assert.ok((await new PrStore(db).getPr('o/r#99')) !== null);
    });
  });

  it("adopts a new PR that reuses a concluded item's branch", async () => {
    const env = await tempEnv();
    await fixture(env);
    // A ticket-worker registered a branch-keyed row (no number yet), which
    // then concluded. A later open PR reuses that branch name; the stale row
    // must not block adopting it.
    await withDatabase(undefined, env, async (db) => {
      await new PrStore(db).upsertPr({
        id: 'o/r#legacy',
        ticket: null,
        origin: 'prompt',
        repo: 'o/r',
        prNumber: null,
        url: null,
        branch: 'reused-branch',
        title: 'legacy',
        injected: false,
        priority: null,
        updatedAt: nowIso(),
      });
      await new CoordinationStore(db).recordOutcome(
        {
          node: 'o/r#legacy',
          outcome: 'delivered',
          retryable: null,
          detail: null,
          recordedAt: nowIso(),
        },
        {session: 's'}
      );
    });
    const adopted = await adoptOrphans(env, {
      list: () => Promise.resolve([{number: 5, headRefName: 'reused-branch'}]),
    });
    assert.equal(adopted, 1);
    await withDatabase(undefined, env, async (db) => {
      assert.ok((await new PrStore(db).getPr('o/r#5')) !== null);
    });
  });

  it('never re-adopts a concluded numbered PR that reopens', async () => {
    const env = await tempEnv();
    await fixture(env);
    // o/r#5 concluded, then GitHub reopens PR #5. A number is a permanent
    // identity: adoption must leave it alone. Re-adopting would only rewrite
    // the pr row — the stale outcome stays, so the item never goes live — and
    // the sweep would churn a phantom adoption every tick.
    await withDatabase(undefined, env, async (db) => {
      await new PrStore(db).upsertPr({
        id: 'o/r#5',
        ticket: null,
        origin: 'prompt',
        repo: 'o/r',
        prNumber: 5,
        url: null,
        branch: 'was-shipped',
        title: 'concluded',
        injected: false,
        priority: null,
        updatedAt: nowIso(),
      });
      await new CoordinationStore(db).recordOutcome(
        {
          node: 'o/r#5',
          outcome: 'delivered',
          retryable: null,
          detail: null,
          recordedAt: nowIso(),
        },
        {session: 's'}
      );
    });
    const adopted = await adoptOrphans(env, {
      list: () => Promise.resolve([{number: 5, headRefName: 'was-shipped'}]),
    });
    assert.equal(adopted, 0);
  });

  it('skips a malformed listing entry', async () => {
    const env = await tempEnv();
    await fixture(env);
    const adopted = await adoptOrphans(env, {
      list: () => Promise.resolve([{number: 0, headRefName: ''}]),
    });
    assert.equal(adopted, 0);
  });

  it('an adopted PR dispatches as resume, not available', async () => {
    const env = await tempEnv();
    await fixture(env);
    await adoptOrphans(env, {
      list: () => Promise.resolve([{number: 12, headRefName: 'x'}]),
    });
    await withDatabase(undefined, env, async (db) => {
      const {dispatchQueue} = await import('../graph/index.mts');
      const entry = (await dispatchQueue(db, {now: nowIso()})).find(
        (e) => e.entry.item.id === 'o/r#12'
      );
      // A resume pass makes the pr-worker re-derive from the existing PR;
      // available would have it implement from the synthetic title.
      assert.equal(entry?.pass, 'resume');
    });
  });
});
