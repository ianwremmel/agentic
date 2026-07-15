import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {derive, type Classification} from './derive.mts';
import {edge, node, snapshot} from './test-support.mts';
import type {Claim, GraphSnapshot} from './types.mts';

function classificationOf(graph: GraphSnapshot, id: string): Classification {
  const entry = derive(graph).nodes.find(
    (candidate) => candidate.node.id === id
  );
  assert.ok(entry, `expected ${id} in the derived graph`);
  return entry.classification;
}

function claim(id: string, heartbeatAt: string): Claim {
  return {id, agent: 'agent-a', heartbeatAt};
}

describe('classification', () => {
  it('puts an unblocked available task on the frontier', () => {
    const graph = derive(snapshot({nodes: [node('A')]}));

    assert.deepEqual(
      graph.available.map((entry) => entry.node.id),
      ['A']
    );
  });

  it('classifies a task with an open ancestor as blocked, naming every unresolved ancestor', () => {
    const graph = derive(
      snapshot({
        nodes: [node('A'), node('B'), node('C')],
        edges: [edge('A', 'B'), edge('B', 'C')],
      })
    );

    assert.deepEqual(
      graph.blocked.map((entry) => entry.node.id),
      ['B', 'C']
    );
    assert.deepEqual(graph.blocked[1]?.blockedBy, ['A', 'B']);
  });

  it('releases the dependents of a canceled task', () => {
    const graph = derive(
      snapshot({
        nodes: [node('A', {role: 'canceled'}), node('B')],
        edges: [edge('A', 'B')],
      })
    );

    assert.deepEqual(
      graph.available.map((entry) => entry.node.id),
      ['B']
    );
  });

  it('reports started work as in-flight', () => {
    const graph = snapshot({nodes: [node('A', {role: 'in-progress'})]});
    assert.equal(classificationOf(graph, 'A'), 'in-flight');
  });

  it('reports a backlog task as dormant, however blocked', () => {
    const graph = snapshot({
      nodes: [node('A'), node('B', {role: 'backlog'})],
      edges: [edge('A', 'B')],
    });
    assert.equal(classificationOf(graph, 'B'), 'dormant');
    assert.equal(derive(graph).blocked.length, 0);
  });

  it('never offers a human-only task to an agent', () => {
    const graph = derive(
      snapshot({nodes: [node('A', {targetKind: 'human-only'})]})
    );
    assert.deepEqual(graph.available, []);
    assert.deepEqual(
      graph.humanBlocked.map((entry) => entry.node.id),
      ['A']
    );
  });
});

describe('claims', () => {
  const NOW = Date.parse('2026-07-14T00:00:00.000Z');
  const TEN_MIN = 10 * 60 * 1000;

  it('reports a live-claimed available task as in-flight, and off the frontier', () => {
    const graph = derive(
      snapshot({
        nodes: [node('A')],
        claims: [claim('A', '2026-07-13T23:59:00.000Z')],
      }),
      {nowMs: NOW, staleAfterMs: TEN_MIN}
    );

    assert.deepEqual(graph.available, []);
    const entry = graph.nodes[0];
    assert.ok(entry);
    assert.equal(entry.classification, 'in-flight');
    assert.equal(entry.claim?.live, true);
    // The claim does not overwrite the tracker's role.
    assert.equal(entry.node.role, 'available');
  });

  it('ignores a stale claim, so the task returns to the frontier', () => {
    const graph = derive(
      snapshot({
        nodes: [node('A')],
        claims: [claim('A', '2026-07-13T00:00:00.000Z')],
      }),
      {nowMs: NOW, staleAfterMs: TEN_MIN}
    );

    assert.deepEqual(
      graph.available.map((entry) => entry.node.id),
      ['A']
    );
    assert.equal(graph.nodes[0]?.claim?.live, false);
  });
});

describe('milestone-edge gating', () => {
  it('gates a task behind an unreviewed milestone, then opens on the review', () => {
    const base = snapshot({
      nodes: [
        node('A', {role: 'verified', milestone: 'm1'}),
        node('B', {role: 'available', milestone: 'm2'}),
      ],
      milestones: [
        {id: 'm1', project: 'P', name: 'M1'},
        {id: 'm2', project: 'P', name: 'M2'},
      ],
      edges: [edge('m1', 'm2')],
    });

    const gated = derive(base);
    const gatedB = gated.blocked[0];
    assert.ok(gatedB);
    assert.equal(gatedB.node.id, 'B');
    assert.deepEqual(gatedB.gatedBy, ['m1']);

    const reviewed = derive({
      ...base,
      reviews: [
        {
          milestone: 'm1',
          fingerprint: gated.milestones[0]?.fingerprint ?? '',
          recordedAt: '2026-07-10T00:00:00.000Z',
        },
      ],
    });
    assert.deepEqual(
      reviewed.available.map((entry) => entry.node.id),
      ['B']
    );
  });
});

describe('counts and termination', () => {
  it('calls a project terminal only when nothing is left to act on', () => {
    const graph = derive(
      snapshot({
        nodes: [node('A', {role: 'verified'}), node('B', {role: 'canceled'})],
      })
    );
    assert.equal(graph.counts[0]?.terminal, true);
  });

  it('holds a project open on a dormant backlog task', () => {
    const graph = derive(
      snapshot({
        nodes: [node('A', {role: 'verified'}), node('B', {role: 'backlog'})],
      })
    );
    assert.equal(graph.counts[0]?.terminal, false);
  });

  it('never calls a partially-fetched project terminal', () => {
    const graph = derive(
      snapshot({
        nodes: [
          node('A', {role: 'verified'}),
          node('X', {project: 'OTHER', role: 'verified'}),
        ],
      })
    );
    const other = graph.counts.find((count) => count.project === 'OTHER');
    assert.ok(other);
    assert.equal(other.partial, true);
    assert.equal(other.terminal, false);
  });
});

describe('anomalies', () => {
  it('surfaces a cycle', () => {
    const graph = derive(
      snapshot({
        nodes: [node('A'), node('B')],
        edges: [edge('A', 'B'), edge('B', 'A')],
      })
    );
    assert.equal(graph.anomalies[0]?.kind, 'cycle');
  });

  it('distinguishes a missing blocker from a missing dependent', () => {
    const graph = derive(
      snapshot({
        nodes: [node('A'), node('B')],
        edges: [edge('GHOST', 'B'), edge('A', 'PHANTOM')],
      })
    );
    const dangling = graph.anomalies.filter((a) => a.kind === 'dangling-edge');
    assert.equal(dangling.length, 2);
    assert.match(String(dangling[0]?.detail), /held blocked until GHOST/);
  });

  it('surfaces an edge that joins a task and a milestone', () => {
    const graph = derive(
      snapshot({
        nodes: [node('A')],
        milestones: [{id: 'm1', project: 'P', name: 'M1'}],
        edges: [edge('m1', 'A')],
      })
    );
    const mixed = graph.anomalies.find((a) => a.kind === 'task-milestone-edge');
    assert.ok(mixed);
    assert.deepEqual(mixed.nodes, ['m1', 'A']);
  });

  it('surfaces a task in a milestone the graph does not hold', () => {
    const graph = derive(snapshot({nodes: [node('A', {milestone: 'ghost'})]}));
    assert.equal(graph.anomalies[0]?.kind, 'unknown-milestone');
  });
});
