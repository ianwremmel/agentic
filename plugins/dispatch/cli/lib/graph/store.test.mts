import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {fingerprintMembers} from './milestones.mts';
import {GraphStore, type GraphDelta, type IngestNode} from './store.mts';
import {node} from './test-support.mts';

function ingestNode(
  id: string,
  overrides: Partial<IngestNode> = {}
): IngestNode {
  return {...node(id), ...overrides};
}

function delta(overrides: Partial<GraphDelta> = {}): GraphDelta {
  return {
    projects: [{id: 'P', name: 'Project', declared: true}],
    milestones: [],
    nodes: [],
    cursors: {},
    ...overrides,
  };
}

async function openStore(): Promise<GraphStore> {
  return GraphStore.open(':memory:');
}

describe('applying a delta', () => {
  it('merges an update into the ticket already stored', async () => {
    const store = await openStore();

    await store.applyDelta(
      delta({nodes: [ingestNode('A', {role: 'available'})]})
    );
    await store.applyDelta(
      delta({nodes: [ingestNode('A', {role: 'in-progress', title: 'Renamed'})]})
    );

    const {nodes} = await store.snapshot();
    const stored = nodes[0];
    assert.ok(stored);
    assert.equal(nodes.length, 1);
    assert.equal(stored.role, 'in-progress');
    assert.equal(stored.title, 'Renamed');

    await store.close();
  });

  it('leaves a ticket the delta says nothing about alone', async () => {
    const store = await openStore();

    await store.applyDelta(
      delta({nodes: [ingestNode('A'), ingestNode('B', {role: 'verified'})]})
    );
    await store.applyDelta(
      delta({nodes: [ingestNode('A', {role: 'delivered'})]})
    );

    const {nodes} = await store.snapshot();
    assert.equal(nodes.find((entry) => entry.id === 'B')?.role, 'verified');

    await store.close();
  });

  it('records an edge once even when both of its tickets declare it', async () => {
    const store = await openStore();

    const result = await store.applyDelta(
      delta({
        nodes: [
          ingestNode('A', {blocks: ['B']}),
          ingestNode('B', {blockedBy: ['A']}),
        ],
      })
    );

    assert.equal(result.edgesWritten, 1);
    const {edges} = await store.snapshot();
    assert.deepEqual(edges, [{blocker: 'A', blocked: 'B'}]);

    await store.close();
  });

  it('drops a dependency the tracker dropped, because a declared direction is authoritative', async () => {
    const store = await openStore();

    await store.applyDelta(
      delta({nodes: [ingestNode('B', {blockedBy: ['A']})]})
    );
    await store.applyDelta(delta({nodes: [ingestNode('B', {blockedBy: []})]}));

    const {edges} = await store.snapshot();
    assert.deepEqual(edges, []);

    await store.close();
  });

  it('leaves the undeclared direction alone when a delta declares only one', async () => {
    // B says who blocks it. It says nothing about what it blocks, so the edge
    // B -> C must survive — otherwise a partial fetch silently unblocks C.
    const store = await openStore();

    await store.applyDelta(
      delta({nodes: [ingestNode('B', {blockedBy: ['A'], blocks: ['C']})]})
    );
    await store.applyDelta(delta({nodes: [ingestNode('B', {blockedBy: []})]}));

    const {edges} = await store.snapshot();
    assert.deepEqual(edges, [{blocker: 'B', blocked: 'C'}]);

    await store.close();
  });

  it('removes a deleted ticket and every edge that touched it', async () => {
    const store = await openStore();

    await store.applyDelta(
      delta({
        nodes: [
          ingestNode('A', {blocks: ['B']}),
          ingestNode('B', {blocks: ['C']}),
          ingestNode('C'),
        ],
      })
    );
    await store.applyDelta(
      delta({nodes: [{...ingestNode('B'), deleted: true}]})
    );

    const {nodes, edges} = await store.snapshot();
    assert.deepEqual(
      nodes.map((entry) => entry.id),
      ['A', 'C']
    );
    assert.deepEqual(edges, []);

    await store.close();
  });

  it('does not let a neighbour resurrect an edge to a ticket the same delta deleted', async () => {
    // B's fetch saw A before A was deleted, so B still declares `blockedBy: [A]`.
    // Re-inserting that edge would leave the graph depending on a ticket it does
    // not hold — which reads as an unresolved blocker and strands B forever.
    const store = await openStore();

    await store.applyDelta(
      delta({nodes: [ingestNode('A'), ingestNode('B', {blockedBy: ['A']})]})
    );
    await store.applyDelta(
      delta({
        nodes: [
          {...ingestNode('A'), deleted: true},
          ingestNode('B', {blockedBy: ['A']}),
        ],
      })
    );

    const {nodes, edges} = await store.snapshot();
    assert.deepEqual(
      nodes.map((entry) => entry.id),
      ['B']
    );
    assert.deepEqual(edges, []);

    await store.close();
  });

  it('stores the cursor the payload carried', async () => {
    const store = await openStore();

    await store.applyDelta(
      delta({cursors: {linear: '2026-07-11T00:00:00.000Z'}})
    );

    assert.equal(await store.getCursor('linear'), '2026-07-11T00:00:00.000Z');
    assert.equal(await store.getCursor('jira'), null);

    await store.close();
  });
});

describe('a full sync', () => {
  it('drops the tickets that have left the tracker', async () => {
    const store = await openStore();

    await store.applyDelta(
      delta({nodes: [ingestNode('A'), ingestNode('GONE')]})
    );
    await store.applyDelta(delta({nodes: [ingestNode('A')]}), {full: true});

    const {nodes} = await store.snapshot();
    assert.deepEqual(
      nodes.map((entry) => entry.id),
      ['A']
    );

    await store.close();
  });

  it('keeps the exclusions, which are the orchestrator bookkeeping a producer must not overwrite', async () => {
    const store = await openStore();

    await store.applyDelta(delta({nodes: [ingestNode('A')]}));
    await store.addExclusion('A', 'in-flight');

    await store.applyDelta(delta({nodes: [ingestNode('A')]}), {full: true});

    assert.deepEqual(await store.listExclusions(), [
      {id: 'A', kind: 'in-flight'},
    ]);

    await store.close();
  });
});

describe('review records', () => {
  it('survives an ingest that leaves the milestone ready', async () => {
    const store = await openStore();
    const milestones = [{id: 'm1', project: 'P', name: 'One', sortOrder: 1}];

    await store.applyDelta(
      delta({
        milestones,
        nodes: [ingestNode('A', {role: 'verified', milestone: 'm1'})],
      })
    );
    await store.recordReview(
      'm1',
      fingerprintMembers(['A']),
      '2026-07-11T00:00:00.000Z'
    );

    const result = await store.applyDelta(
      delta({
        milestones,
        nodes: [ingestNode('A', {role: 'verified', milestone: 'm1'})],
      })
    );

    assert.equal(result.reviewsDropped, 0);
    assert.equal((await store.snapshot()).reviews.length, 1);

    await store.close();
  });

  it('is dropped when a member is reopened, so the re-completed milestone is reviewed again', async () => {
    // The member set is unchanged, so a fingerprint alone would still match. §2.6
    // requires a fresh review of the new episode, so the record has to go.
    const store = await openStore();
    const milestones = [{id: 'm1', project: 'P', name: 'One', sortOrder: 1}];

    await store.applyDelta(
      delta({
        milestones,
        nodes: [ingestNode('A', {role: 'verified', milestone: 'm1'})],
      })
    );
    await store.recordReview(
      'm1',
      fingerprintMembers(['A']),
      '2026-07-11T00:00:00.000Z'
    );

    const result = await store.applyDelta(
      delta({
        milestones,
        nodes: [ingestNode('A', {role: 'in-progress', milestone: 'm1'})],
      })
    );

    assert.equal(result.reviewsDropped, 1);
    assert.deepEqual((await store.snapshot()).reviews, []);

    await store.close();
  });
});
