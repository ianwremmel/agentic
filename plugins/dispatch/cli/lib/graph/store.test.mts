import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {GraphStore} from './store.mts';
import {node} from './test-support.mts';
import type {GraphNode} from './types.mts';

async function openStore(): Promise<GraphStore> {
  return GraphStore.open(':memory:');
}

function task(id: string, overrides: Partial<GraphNode> = {}): GraphNode {
  return node(id, overrides);
}

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse('2026-07-14T12:00:00.000Z');

describe('tasks and edges', () => {
  it('upserts a task and reads it back', async () => {
    const store = await openStore();
    await store.upsertTask(task('A', {role: 'in-progress', title: 'Thing'}));
    await store.upsertTask(task('A', {role: 'in-review', title: 'Renamed'}));

    const {nodes} = await store.snapshot();
    const stored = nodes[0];
    assert.ok(stored);
    assert.equal(nodes.length, 1);
    assert.equal(stored.role, 'in-review');
    assert.equal(stored.title, 'Renamed');
    await store.close();
  });

  it('removes a task with its edges and claim', async () => {
    const store = await openStore();
    await store.upsertTask(task('A'));
    await store.upsertTask(task('B'));
    await store.addEdge('A', 'B');
    await store.claim('A', 'agent-a', NOW, HOUR, true);

    assert.equal(await store.removeTask('A'), true);
    const snap = await store.snapshot();
    assert.deepEqual(
      snap.nodes.map((n) => n.id),
      ['B']
    );
    assert.deepEqual(snap.edges, []);
    assert.deepEqual(snap.claims, []);
    await store.close();
  });

  it('replaces one direction of a node with edge set, leaving the other alone', async () => {
    const store = await openStore();
    await store.setEdges('B', 'blockers', ['A']);
    await store.setEdges('B', 'blocks', ['C']);
    // Re-declare B's blockers as exactly {A2}; B->C must survive.
    await store.setEdges('B', 'blockers', ['A2']);

    const {edges} = await store.snapshot();
    assert.deepEqual(edges, [
      {blocker: 'A2', blocked: 'B'},
      {blocker: 'B', blocked: 'C'},
    ]);
    await store.close();
  });

  it('clears a direction when edge set is given an empty list', async () => {
    const store = await openStore();
    await store.setEdges('B', 'blockers', ['A']);
    await store.setEdges('B', 'blockers', []);
    assert.deepEqual((await store.snapshot()).edges, []);
    await store.close();
  });

  it('refuses an id that already names the other kind', async () => {
    // Tasks and milestones share the edge id space, so a collision would make
    // an edge ambiguous and a delete wipe the wrong kind's edges.
    const store = await openStore();
    await store.upsertMilestone({id: 'X', project: 'P', name: 'X'});
    await assert.rejects(
      () => store.upsertTask(task('X')),
      /already a milestone/
    );

    await store.upsertTask(task('Y'));
    await assert.rejects(
      () => store.upsertMilestone({id: 'Y', project: 'P', name: 'Y'}),
      /already a task/
    );
    await store.close();
  });

  it('reset wipes the graph but keeps claims and reviews', async () => {
    const store = await openStore();
    await store.upsertTask(task('A'));
    await store.upsertMilestone({id: 'm1', project: 'P', name: 'M1'});
    await store.claim('A', 'agent-a', NOW, HOUR, true);
    await store.recordReview('m1', 'fp', '2026-07-10T00:00:00.000Z');

    await store.reset();

    const snap = await store.snapshot();
    assert.deepEqual(snap.nodes, []);
    assert.deepEqual(snap.milestones, []);
    assert.equal(snap.claims.length, 1);
    assert.equal(snap.reviews.length, 1);
    await store.close();
  });
});

describe('claims', () => {
  it('claims a free, available task', async () => {
    const store = await openStore();
    const result = await store.claim('A', 'agent-a', NOW, HOUR, true);
    assert.equal(result.outcome, 'claimed');
    await store.close();
  });

  it('refuses to claim a free task that is not available', async () => {
    const store = await openStore();
    const result = await store.claim('A', 'agent-a', NOW, HOUR, false);
    assert.equal(result.outcome, 'not-available');
    assert.deepEqual((await store.snapshot()).claims, []);
    await store.close();
  });

  it('a re-claim by the holder just refreshes the heartbeat', async () => {
    const store = await openStore();
    await store.claim('A', 'agent-a', NOW, HOUR, true);
    const later = NOW + 5 * 60 * 1000;
    const result = await store.claim('A', 'agent-a', later, HOUR, false);
    assert.equal(result.outcome, 'refreshed');
    assert.equal(
      (await store.snapshot()).claims[0]?.heartbeatAt,
      new Date(later).toISOString()
    );
    await store.close();
  });

  it('refuses a live claim held by another agent', async () => {
    const store = await openStore();
    await store.claim('A', 'agent-a', NOW, HOUR, true);
    const result = await store.claim('A', 'agent-b', NOW + 60_000, HOUR, true);
    assert.equal(result.outcome, 'held');
    assert.equal(result.heldBy, 'agent-a');
    await store.close();
  });

  it('reclaims a stale claim for a new agent', async () => {
    const store = await openStore();
    await store.claim('A', 'agent-a', NOW, HOUR, true);
    // Two hours later, agent-a's claim is stale.
    const result = await store.claim(
      'A',
      'agent-b',
      NOW + 2 * HOUR,
      HOUR,
      true
    );
    assert.equal(result.outcome, 'reclaimed');
    assert.equal((await store.snapshot()).claims[0]?.agent, 'agent-b');
    await store.close();
  });

  it('claimNext takes the first candidate no live agent holds', async () => {
    const store = await openStore();
    await store.claim('A', 'agent-a', NOW, HOUR, true); // A held live
    const taken = await store.claimNext(
      ['A', 'B', 'C'],
      'agent-b',
      NOW + 60_000,
      HOUR
    );
    assert.equal(taken?.id, 'B');
    await store.close();
  });

  it('heartbeat refreshes only the holder', async () => {
    const store = await openStore();
    await store.claim('A', 'agent-a', NOW, HOUR, true);
    assert.equal(await store.heartbeat('A', 'agent-b', NOW + 60_000), false);
    assert.equal(await store.heartbeat('A', 'agent-a', NOW + 60_000), true);
    await store.close();
  });

  it('release is idempotent and refuses another agent', async () => {
    const store = await openStore();
    await store.claim('A', 'agent-a', NOW, HOUR, true);
    assert.equal(await store.release('A', 'agent-b'), 'not-yours');
    assert.equal(await store.release('A', 'agent-a'), 'released');
    assert.equal(await store.release('A', 'agent-a'), 'absent');
    await store.close();
  });
});

describe('cursors', () => {
  it('stores, reads, and clears a cursor', async () => {
    const store = await openStore();
    await store.setCursor('linear', '2026-07-11T00:00:00.000Z');
    assert.equal(await store.getCursor('linear'), '2026-07-11T00:00:00.000Z');
    assert.equal(await store.clearCursor('linear'), true);
    assert.equal(await store.getCursor('linear'), null);
    await store.close();
  });
});
