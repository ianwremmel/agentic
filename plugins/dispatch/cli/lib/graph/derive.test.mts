import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {derive} from './derive.mts';
import type {GraphStore} from './store.mts';
import {node, seededStore, type SeedSpec} from './test-support.mts';
import type {Classification, DerivedGraph} from './types.mts';

const NOW = Date.parse('2026-07-14T00:00:00.000Z');
const TEN_MIN = 10 * 60 * 1000;

async function derived(
  spec: SeedSpec,
  options: Parameters<typeof derive>[1] = {}
): Promise<DerivedGraph> {
  const store = await seededStore(spec);
  try {
    return derive(store.database, options);
  } finally {
    await store.close();
  }
}

function classificationOf(graph: DerivedGraph, id: string): Classification {
  const entry = graph.nodes.find((candidate) => candidate.node.id === id);
  assert.ok(entry, `expected ${id} in the derived graph`);
  return entry.classification;
}

describe('classification', () => {
  it('puts an unblocked available task on the frontier', async () => {
    const graph = await derived({nodes: [node('A')]});

    assert.deepEqual(
      graph.available.map((entry) => entry.node.id),
      ['A']
    );
  });

  it('classifies a task with an open ancestor as blocked, naming every unresolved ancestor', async () => {
    const graph = await derived({
      nodes: [node('A'), node('B'), node('C')],
      edges: [
        ['A', 'B'],
        ['B', 'C'],
      ],
    });

    assert.deepEqual(
      graph.blocked.map((entry) => entry.node.id),
      ['B', 'C']
    );
    assert.deepEqual(graph.blocked[1]?.blockedBy, ['A', 'B']);
  });

  it('releases the dependents of a canceled task', async () => {
    const graph = await derived({
      nodes: [node('A', {role: 'canceled'}), node('B')],
      edges: [['A', 'B']],
    });

    assert.deepEqual(
      graph.available.map((entry) => entry.node.id),
      ['B']
    );
  });

  it('stops the blocking walk at a resolved ancestor, releasing what sits behind it', async () => {
    // A (open) blocks B (canceled) blocks C. Cancellation releases downstream
    // work: C must not be held behind the abandoned B's own open blockers.
    const graph = await derived({
      nodes: [node('A'), node('B', {role: 'canceled'}), node('C')],
      edges: [
        ['A', 'B'],
        ['B', 'C'],
      ],
    });

    assert.equal(classificationOf(graph, 'C'), 'available');
  });

  it('reports started work as in-flight', async () => {
    const graph = await derived({nodes: [node('A', {role: 'in-progress'})]});
    assert.equal(classificationOf(graph, 'A'), 'in-flight');
  });

  it('reports a backlog task as dormant, however blocked', async () => {
    const graph = await derived({
      nodes: [node('A'), node('B', {role: 'backlog'})],
      edges: [['A', 'B']],
    });
    assert.equal(classificationOf(graph, 'B'), 'dormant');
    assert.equal(graph.blocked.length, 0);
  });

  it('never offers a human-only task to an agent', async () => {
    const graph = await derived({
      nodes: [node('A', {targetKind: 'human-only'})],
    });
    assert.deepEqual(graph.available, []);
    assert.deepEqual(
      graph.humanBlocked.map((entry) => entry.node.id),
      ['A']
    );
  });

  it('holds a dependent behind a blocker nobody has fetched', async () => {
    const graph = await derived({
      nodes: [node('B')],
      edges: [['GHOST', 'B']],
    });
    assert.equal(classificationOf(graph, 'B'), 'blocked');
    assert.deepEqual(graph.blocked[0]?.blockedBy, ['GHOST']);
  });
});

describe('ranking', () => {
  it('orders the frontier: injected, then priority, then fan-out, then id', async () => {
    const graph = await derived({
      nodes: [
        // Fan-out: A transitively unblocks B and C; D unblocks nothing.
        node('A'),
        node('B', {role: 'backlog'}),
        node('C', {role: 'backlog'}),
        node('D'),
        node('E', {priority: 1}),
        node('F', {injected: true}),
      ],
      edges: [
        ['A', 'B'],
        ['B', 'C'],
      ],
    });

    assert.deepEqual(
      graph.available.map((entry) => entry.node.id),
      // F is injected; E has a priority (beats none); A's fan-out of 2 beats
      // D's 0; ids break the remaining tie.
      ['F', 'E', 'A', 'D']
    );
  });

  it('sorts an absent priority after any real one', async () => {
    const graph = await derived({
      nodes: [node('A'), node('B', {priority: 4})],
    });
    assert.deepEqual(
      graph.available.map((entry) => entry.node.id),
      ['B', 'A']
    );
  });
});

describe('claims', () => {
  async function claimedStore(heartbeatAtMs: number): Promise<GraphStore> {
    const store = await seededStore({nodes: [node('A')]});
    const result = await store.claim('A', 'agent-a', {
      nowMs: heartbeatAtMs,
      staleAfterMs: TEN_MIN,
    });
    assert.equal(result.outcome, 'claimed');
    return store;
  }

  it('reports a live-claimed available task as in-flight, and off the frontier', async () => {
    const store = await claimedStore(NOW - 60_000);
    const graph = derive(store.database, {nowMs: NOW, staleAfterMs: TEN_MIN});

    assert.deepEqual(graph.available, []);
    const entry = graph.nodes[0];
    assert.ok(entry);
    assert.equal(entry.classification, 'in-flight');
    assert.equal(entry.claim?.live, true);
    // The claim does not overwrite the tracker's role.
    assert.equal(entry.node.role, 'available');
    await store.close();
  });

  it('ignores a stale claim, so the task returns to the frontier', async () => {
    const store = await claimedStore(NOW - 24 * 60 * 60 * 1000);
    const graph = derive(store.database, {nowMs: NOW, staleAfterMs: TEN_MIN});

    assert.deepEqual(
      graph.available.map((entry) => entry.node.id),
      ['A']
    );
    assert.equal(graph.nodes[0]?.claim?.live, false);
    await store.close();
  });
});

describe('milestone gating', () => {
  const TWO_MILESTONES: SeedSpec = {
    milestones: [
      {id: 'm1', project: 'P', name: 'M1'},
      {id: 'm2', project: 'P', name: 'M2'},
    ],
    nodes: [
      node('A', {role: 'verified', milestone: 'm1'}),
      node('B', {role: 'available', milestone: 'm2'}),
    ],
    edges: [['m1', 'm2']],
  };

  it('gates a task behind an unreviewed milestone, then opens on the review', async () => {
    const store = await seededStore(TWO_MILESTONES);

    const gated = derive(store.database);
    const gatedB = gated.blocked[0];
    assert.ok(gatedB);
    assert.equal(gatedB.node.id, 'B');
    assert.deepEqual(gatedB.gatedBy, ['m1']);

    await store.recordReview('m1', NOW, {});
    const reviewed = derive(store.database);
    assert.deepEqual(
      reviewed.available.map((entry) => entry.node.id),
      ['B']
    );
    await store.close();
  });

  it('gates across the whole milestone ancestry, not just the direct predecessor', async () => {
    const store = await seededStore({
      milestones: [
        {id: 'm1', project: 'P', name: 'M1'},
        {id: 'm2', project: 'P', name: 'M2'},
        {id: 'm3', project: 'P', name: 'M3'},
      ],
      nodes: [
        node('A', {role: 'verified', milestone: 'm1'}),
        node('B', {role: 'verified', milestone: 'm2'}),
        node('C', {milestone: 'm3'}),
      ],
      edges: [
        ['m1', 'm2'],
        ['m2', 'm3'],
      ],
    });

    const graph = derive(store.database);
    assert.deepEqual(graph.blocked[0]?.gatedBy, ['m1', 'm2']);
    await store.close();
  });

  it('re-closes the gate when a follow-up task joins the reviewed milestone', async () => {
    const store = await seededStore(TWO_MILESTONES);
    await store.recordReview('m1', NOW, {});

    // The review filed a follow-up into m1: the member set changes, so the
    // recorded review no longer covers this milestone.
    await store.upsertTask(node('A2', {milestone: 'm1'}));

    const graph = derive(store.database);
    const m1 = graph.milestones.find((entry) => entry.id === 'm1');
    assert.equal(m1?.reviewRecorded, false);
    assert.equal(classificationOf(graph, 'B'), 'blocked');
    await store.close();
  });

  it('re-closes the gate when a member moved after the review was recorded', async () => {
    const store = await seededStore(TWO_MILESTONES);
    await store.recordReview('m1', NOW, {});

    // A was reopened and re-verified between two syncs: the ids are unchanged,
    // but the tracker's updatedAt says it moved after the review ran.
    await store.upsertTask(
      node('A', {
        role: 'verified',
        milestone: 'm1',
        updatedAt: new Date(NOW + 60_000).toISOString(),
      })
    );

    const graph = derive(store.database);
    assert.equal(
      graph.milestones.find((entry) => entry.id === 'm1')?.reviewRecorded,
      false
    );
    await store.close();
  });

  it('never calls an empty milestone ready', async () => {
    const graph = await derived({
      milestones: [{id: 'm1', project: 'P', name: 'M1'}],
    });
    assert.equal(graph.milestones[0]?.readyForReview, false);
  });

  it('holds a milestone un-ready while a member is open', async () => {
    const graph = await derived({
      milestones: [{id: 'm1', project: 'P', name: 'M1'}],
      nodes: [
        node('A', {role: 'verified', milestone: 'm1'}),
        node('B', {role: 'available', milestone: 'm1'}),
      ],
    });
    const m1 = graph.milestones[0];
    assert.ok(m1);
    assert.equal(m1.readyForReview, false);
    assert.equal(m1.openCount, 1);
  });

  it('holds a milestone un-ready while a member has an unresolved dependency', async () => {
    const graph = await derived({
      milestones: [{id: 'm1', project: 'P', name: 'M1'}],
      nodes: [node('A', {role: 'verified', milestone: 'm1'}), node('X')],
      edges: [['X', 'A']],
    });
    assert.equal(graph.milestones[0]?.readyForReview, false);
  });
});

describe('counts and termination', () => {
  it('calls a project terminal only when nothing is left to act on', async () => {
    const graph = await derived({
      nodes: [node('A', {role: 'verified'}), node('B', {role: 'canceled'})],
    });
    assert.equal(graph.counts[0]?.terminal, true);
  });

  it('holds a project open on a dormant backlog task', async () => {
    const graph = await derived({
      nodes: [node('A', {role: 'verified'}), node('B', {role: 'backlog'})],
    });
    assert.equal(graph.counts[0]?.terminal, false);
  });

  it('never calls a partially-fetched project terminal', async () => {
    const graph = await derived({
      nodes: [
        node('A', {role: 'verified'}),
        node('X', {project: 'OTHER', role: 'verified'}),
      ],
    });
    const other = graph.counts.find((count) => count.project === 'OTHER');
    assert.ok(other);
    assert.equal(other.partial, true);
    assert.equal(other.terminal, false);
  });
});

describe('anomalies', () => {
  it('surfaces a cycle in a hand-edited database as a safety net', async () => {
    // The write surface refuses cycle-closing edges, so plant one behind its
    // back — the read side still has to see it.
    const store = await seededStore({
      nodes: [node('A'), node('B')],
      edges: [['A', 'B']],
    });
    store.database.run(
      `INSERT INTO edge (blocker, blocked)
       SELECT nb.id, nd.id FROM node nb, node nd
       WHERE nb.external_id = 'B' AND nd.external_id = 'A'`
    );

    const graph = derive(store.database);
    const cycle = graph.anomalies[0];
    assert.ok(cycle);
    assert.equal(cycle.kind, 'cycle');
    assert.deepEqual(cycle.nodes, ['A', 'B']);
    await store.close();
  });

  it('distinguishes a missing blocker from a missing dependent', async () => {
    const graph = await derived({
      nodes: [node('A'), node('B')],
      edges: [
        ['GHOST', 'B'],
        ['A', 'PHANTOM'],
      ],
    });
    const dangling = graph.anomalies.filter((a) => a.kind === 'dangling-edge');
    assert.equal(dangling.length, 2);
    assert.match(
      String(dangling.find((a) => a.nodes.includes('GHOST'))?.detail),
      /held blocked until GHOST/
    );
    assert.match(
      String(dangling.find((a) => a.nodes.includes('PHANTOM'))?.detail),
      /schedules nothing/
    );
  });

  it('surfaces a task in a milestone the graph does not hold', async () => {
    const graph = await derived({nodes: [node('A', {milestone: 'ghost'})]});
    const anomaly = graph.anomalies[0];
    assert.ok(anomaly);
    assert.equal(anomaly.kind, 'unknown-milestone');
    assert.deepEqual(anomaly.nodes, ['A']);
  });

  it('surfaces two projects that block each other', async () => {
    const graph = await derived({
      projects: [
        {id: 'P', name: 'P'},
        {id: 'Q', name: 'Q'},
      ],
      nodes: [
        node('A'),
        node('B', {project: 'Q'}),
        node('C', {project: 'Q'}),
        node('D'),
      ],
      edges: [
        ['A', 'B'],
        ['C', 'D'],
      ],
    });
    const reverse = graph.anomalies.find(
      (a) => a.kind === 'cross-project-reverse'
    );
    assert.ok(reverse);
    assert.deepEqual(reverse.nodes, ['A', 'B', 'C', 'D']);
  });
});
