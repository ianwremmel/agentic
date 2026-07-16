import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {dispatchQueue, frontier} from './queries.mts';
import {node, seededStore} from './test-support.mts';

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse('2026-07-14T12:00:00.000Z');
const OPTS = {nowMs: NOW, staleAfterMs: HOUR};

describe('outcome-driven passes', () => {
  it('serves a delivered ticket back as a verify pass, but not a delivered bare PR', async () => {
    const store = await seededStore({
      nodes: [node('A', {role: 'delivered'})],
    });
    await store.addBarePr({
      repo: 'o/r',
      number: 7,
      url: 'https://github.com/o/r/pull/7',
      branch: null,
      title: null,
    });
    await store.setOutcome(
      'A',
      'wt-1',
      {outcome: 'delivered', retryable: null, detail: null},
      NOW
    );
    await store.setOutcome(
      'o/r#7',
      'wt-2',
      {outcome: 'delivered', retryable: null, detail: null},
      NOW
    );

    const queue = dispatchQueue(store.database, OPTS);
    assert.deepEqual(
      queue.map((item) => [item.entry.node.id, item.pass]),
      [['A', 'verify']]
    );
    await store.close();
  });

  it('holds a decomposed parent until every subtask resolves, then serves finalize', async () => {
    const store = await seededStore({
      nodes: [
        node('parent', {role: 'in-progress'}),
        node('sub', {role: 'in-progress'}),
      ],
      edges: [['sub', 'parent']],
    });
    await store.setOutcome(
      'parent',
      'wt-1',
      {outcome: 'decomposed', retryable: null, detail: null},
      NOW
    );

    assert.equal(dispatchQueue(store.database, OPTS).length, 0);

    await store.upsertTask(node('sub', {role: 'verified'}));
    const queue = dispatchQueue(store.database, OPTS);
    assert.deepEqual(
      queue.map((item) => [item.entry.node.id, item.pass]),
      [['parent', 'finalize']]
    );
    await store.close();
  });

  it('serves a retryable failure as a retry pass and parks a structural one', async () => {
    const store = await seededStore({
      nodes: [
        node('flaky', {role: 'in-progress', targetKind: 'verification'}),
        node('broken', {role: 'in-progress', targetKind: 'verification'}),
      ],
    });
    await store.setOutcome(
      'flaky',
      'wt-1',
      {outcome: 'failed', retryable: true, detail: 'target flapped'},
      NOW
    );
    await store.setOutcome(
      'broken',
      'wt-2',
      {outcome: 'failed', retryable: false, detail: 'suite missing'},
      NOW
    );

    const queue = dispatchQueue(store.database, OPTS);
    assert.deepEqual(
      queue.map((item) => [item.entry.node.id, item.pass]),
      [['flaky', 'retry']]
    );
    await store.close();
  });

  it('recording an outcome releases the recorder claim, and a pass item is claimable', async () => {
    const store = await seededStore({nodes: [node('A')]});
    assert.equal((await store.claim('A', 'wt-1', OPTS)).outcome, 'claimed');
    await store.upsertTask(node('A', {role: 'delivered'}));
    await store.setOutcome(
      'A',
      'wt-1',
      {outcome: 'delivered', retryable: null, detail: null},
      NOW
    );

    // The claim went with the outcome, so a fresh verify-pass claim succeeds
    // immediately — no staleness wait.
    assert.equal((await store.claim('A', 'wt-2', OPTS)).outcome, 'claimed');
    await store.close();
  });

  it('keeps outcome-carrying nodes off the available frontier', async () => {
    const store = await seededStore({nodes: [node('A'), node('B')]});
    await store.setOutcome(
      'A',
      'wt-1',
      {outcome: 'failed', retryable: false, detail: null},
      NOW
    );

    assert.deepEqual(
      frontier(store.database, OPTS).map((entry) => entry.node.id),
      ['B']
    );
    await store.close();
  });

  it('clears a recorded outcome when the tracker moves the ticket back to available', async () => {
    const store = await seededStore({
      nodes: [node('A', {role: 'in-progress'})],
    });
    await store.setOutcome(
      'A',
      'wt-1',
      {outcome: 'failed', retryable: false, detail: null},
      NOW
    );
    assert.equal(dispatchQueue(store.database, OPTS).length, 0);

    // A human re-opened the ticket; the refresh writes the new role.
    await store.upsertTask(node('A', {role: 'available'}));
    assert.deepEqual(
      frontier(store.database, OPTS).map((entry) => entry.node.id),
      ['A']
    );
    await store.close();
  });

  it('rejects --retryable on a non-failed outcome', async () => {
    const store = await seededStore({nodes: [node('A')]});
    await assert.rejects(
      () =>
        store.setOutcome(
          'A',
          'wt-1',
          {outcome: 'delivered', retryable: true, detail: null},
          NOW
        ),
      /--retryable is meaningful only with --outcome failed/
    );
    await store.close();
  });
});

describe('injected bare PRs', () => {
  it('ranks an injected PR ahead of ticket work and claims it', async () => {
    const store = await seededStore({nodes: [node('A', {priority: 1})]});
    await store.addBarePr({
      repo: 'o/r',
      number: 7,
      url: 'https://github.com/o/r/pull/7',
      branch: 'feat/x',
      title: null,
    });

    const queue = dispatchQueue(store.database, OPTS);
    assert.deepEqual(
      queue.map((item) => item.entry.node.id),
      ['o/r#7', 'A']
    );
    const top = queue[0];
    assert.ok(top);
    assert.equal(top.entry.node.targetKind, 'bare-pr');
    assert.equal(top.entry.node.branchHint, 'feat/x');

    const claimed = await store.claimNext('wt-1', OPTS);
    assert.ok(claimed);
    assert.equal(claimed.entry.node.id, 'o/r#7');
    assert.equal(claimed.pass, null);
    await store.close();
  });

  it('never counts the PR project toward termination', async () => {
    const store = await seededStore({nodes: []});
    await store.addBarePr({
      repo: 'o/r',
      number: 7,
      url: 'https://github.com/o/r/pull/7',
      branch: null,
      title: null,
    });
    const {derive} = await import('./derive.mts');
    const counts = derive(store.database, OPTS).counts;
    const prProject = counts.find((count) => count.project === 'pr:o/r');
    assert.ok(prProject);
    assert.equal(prProject.partial, true);
    assert.equal(prProject.terminal, false);
    await store.close();
  });

  it('resolves a bare PR by its recorded outcome, not a tracker role', async () => {
    const store = await seededStore({nodes: []});
    await store.addBarePr({
      repo: 'o/r',
      number: 7,
      url: 'https://github.com/o/r/pull/7',
      branch: null,
      title: null,
    });
    await store.setOutcome(
      'o/r#7',
      'wt-1',
      {outcome: 'delivered', retryable: null, detail: null},
      NOW
    );

    const {derive} = await import('./derive.mts');
    const entry = derive(store.database, OPTS).nodes[0];
    assert.ok(entry);
    assert.equal(entry.classification, 'verified');
    await store.close();
  });
});

describe('resume pass', () => {
  it('re-serves a started item whose claim went stale with no outcome', async () => {
    const store = await seededStore({nodes: [node('A')]});
    assert.equal((await store.claim('A', 'wt-dead', OPTS)).outcome, 'claimed');
    await store.upsertTask(node('A', {role: 'in-progress'}));

    // Claim still live: nothing to hand out.
    assert.equal(dispatchQueue(store.database, OPTS).length, 0);

    const later = {...OPTS, nowMs: NOW + 2 * HOUR};
    const queue = dispatchQueue(store.database, later);
    assert.deepEqual(
      queue.map((item) => [item.entry.node.id, item.pass]),
      [['A', 'resume']]
    );
    const claimed = await store.claimNext('wt-new', later);
    assert.equal(claimed?.outcome, 'reclaimed');
    await store.close();
  });

  it('never resumes work parked for a human', async () => {
    const store = await seededStore({nodes: [node('A')]});
    await store.claim('A', 'wt-dead', OPTS);
    await store.upsertTask(node('A', {role: 'awaiting-external'}));

    const later = {...OPTS, nowMs: NOW + 2 * HOUR};
    assert.equal(dispatchQueue(store.database, later).length, 0);
    await store.close();
  });
});

describe('milestone claims (review locks)', () => {
  const spec = {
    milestones: [{id: 'm1', project: 'P', name: 'M1'}],
    nodes: [node('A', {milestone: 'm1', role: 'verified'})],
  };

  it('claims a ready-unreviewed milestone; refuses one with open work', async () => {
    const store = await seededStore({
      ...spec,
      nodes: [node('A', {milestone: 'm1', role: 'in-progress'})],
    });
    assert.equal(
      (await store.claim('m1', 'review-1', OPTS)).outcome,
      'not-available'
    );

    await store.upsertTask(node('A', {milestone: 'm1', role: 'verified'}));
    assert.equal(
      (await store.claim('m1', 'review-1', OPTS)).outcome,
      'claimed'
    );
    await store.close();
  });

  it('record-review releases the lock and stops fresh claims', async () => {
    const store = await seededStore(spec);
    assert.equal(
      (await store.claim('m1', 'review-1', OPTS)).outcome,
      'claimed'
    );
    await store.recordReview('m1', NOW, OPTS);

    // The recorded review is the lock's outcome: the claim is gone, and the
    // reviewed milestone is no longer claimable.
    assert.equal(await store.liveClaimCount(NOW, HOUR), 0);
    assert.equal(
      (await store.claim('m1', 'review-2', OPTS)).outcome,
      'not-available'
    );
    await store.close();
  });
});

describe('slot ledger', () => {
  it('bounds acquisition at max and refreshes a held slot', async () => {
    const store = await seededStore();
    assert.equal(await store.acquireSlot('a', 2, NOW, HOUR), 'acquired');
    assert.equal(await store.acquireSlot('b', 2, NOW, HOUR), 'acquired');
    assert.equal(await store.acquireSlot('c', 2, NOW, HOUR), 'full');
    assert.equal(await store.acquireSlot('a', 2, NOW, HOUR), 'refreshed');
    await store.close();
  });

  it('sweeps a stale holder so a crashed agent cannot leak capacity', async () => {
    const store = await seededStore();
    assert.equal(await store.acquireSlot('dead', 1, NOW, HOUR), 'acquired');
    assert.equal(
      await store.acquireSlot('live', 1, NOW + 2 * HOUR, HOUR),
      'acquired'
    );
    const held = await store.slots(NOW + 2 * HOUR, HOUR);
    assert.deepEqual(held, [{agent: 'live', live: true}]);
    await store.close();
  });

  it('release is idempotent and heartbeat fails once released', async () => {
    const store = await seededStore();
    await store.acquireSlot('a', 1, NOW, HOUR);
    assert.equal(await store.releaseSlot('a'), true);
    assert.equal(await store.releaseSlot('a'), false);
    assert.equal(await store.heartbeatSlot('a', NOW), false);
    await store.close();
  });
});
