import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {derive, type Classification} from './derive.mts';
import {edge, node, snapshot} from './test-support.mts';
import type {GraphSnapshot} from './types.mts';

function classificationOf(graph: GraphSnapshot, id: string): Classification {
  const entry = derive(graph).nodes.find(
    (candidate) => candidate.node.id === id
  );
  assert.ok(entry, `expected ${id} in the derived graph`);
  return entry.classification;
}

describe('classification', () => {
  it('puts an unblocked available ticket on the frontier', () => {
    const graph = derive(snapshot({nodes: [node('A')]}));

    assert.deepEqual(
      graph.available.map((entry) => entry.node.id),
      ['A']
    );
  });

  it('classifies a ticket with an open ancestor as blocked, and names every unresolved ancestor', () => {
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
    assert.deepEqual(
      graph.available.map((entry) => entry.node.id),
      ['A']
    );
  });

  it('reports started work as in-flight rather than blocked or human-blocked', () => {
    // Someone is on it. Reporting it as blocked would put started work in a
    // bucket the orchestrator reads as waiting.
    const graph = snapshot({
      nodes: [node('A'), node('B', {role: 'in-progress'})],
      edges: [edge('A', 'B')],
    });

    assert.equal(classificationOf(graph, 'B'), 'in-flight');
  });

  it('reports a backlog ticket as dormant, however blocked it is', () => {
    // `blocked` would imply clearing its blockers makes it workable. It does not:
    // a human has to promote it first.
    const graph = snapshot({
      nodes: [node('A'), node('B', {role: 'backlog'})],
      edges: [edge('A', 'B')],
    });

    assert.equal(classificationOf(graph, 'B'), 'dormant');
    assert.equal(derive(graph).blocked.length, 0);
  });

  it('holds a human-interactive ticket in blocked until its ancestors resolve, then hands it to a human', () => {
    // The alert should fire once, when acting on it is actually possible.
    const blocked = snapshot({
      nodes: [node('A'), node('H', {humanInteractive: true})],
      edges: [edge('A', 'H')],
    });
    assert.equal(classificationOf(blocked, 'H'), 'blocked');

    const released = snapshot({
      nodes: [
        node('A', {role: 'verified'}),
        node('H', {humanInteractive: true}),
      ],
      edges: [edge('A', 'H')],
    });
    assert.equal(classificationOf(released, 'H'), 'human-blocked');
  });

  it('parks a ticket whose role says a human is holding it', () => {
    const graph = snapshot({
      nodes: [node('A', {role: 'awaiting-external'})],
    });

    assert.equal(classificationOf(graph, 'A'), 'human-blocked');
  });

  it('never offers a human-only ticket to an agent', () => {
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

describe('exclusions', () => {
  it('keeps an in-flight ticket off the frontier without touching its role', () => {
    const graph = derive(
      snapshot({
        nodes: [node('A')],
        exclusions: [{id: 'A', kind: 'in-flight'}],
      })
    );

    const entry = graph.nodes[0];
    assert.ok(entry);
    assert.deepEqual(graph.available, []);
    assert.equal(entry.classification, 'in-flight');
    assert.equal(entry.node.role, 'available');
  });

  it('does not tally a done exclusion as verified: the tracker decides what is verified', () => {
    // Otherwise a project could report itself complete with unverified work in it.
    const graph = derive(
      snapshot({
        nodes: [node('A', {role: 'delivered'})],
        exclusions: [{id: 'A', kind: 'done'}],
      })
    );

    const counts = graph.counts[0];
    assert.ok(counts);
    assert.equal(counts.verified, 0);
    assert.equal(counts.terminal, false);
  });

  it('permanently blocks the work standing behind a failed ticket', () => {
    const graph = derive(
      snapshot({
        nodes: [node('A', {role: 'in-progress'}), node('B'), node('C')],
        edges: [edge('A', 'B'), edge('B', 'C')],
        exclusions: [{id: 'A', kind: 'failed'}],
      })
    );

    assert.deepEqual(
      graph.permanentlyBlocked.map((entry) => entry.node.id).sort(),
      ['A', 'B', 'C']
    );
    assert.equal(
      graph.permanentlyBlocked[1]?.permanentReason,
      'ancestor-failed:A'
    );
  });

  it('does not permanently block the dependents of a canceled ticket', () => {
    // §2.6 is explicit: cancellation unblocks downstream work rather than
    // stranding it.
    const graph = derive(
      snapshot({
        nodes: [node('A', {role: 'canceled'}), node('B')],
        edges: [edge('A', 'B')],
      })
    );

    assert.deepEqual(graph.permanentlyBlocked, []);
    assert.deepEqual(
      graph.available.map((entry) => entry.node.id),
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

  it('holds a project open on a dormant backlog ticket, which can still be promoted', () => {
    const graph = derive(
      snapshot({
        nodes: [node('A', {role: 'verified'}), node('B', {role: 'backlog'})],
      })
    );

    const counts = graph.counts[0];
    assert.ok(counts);
    assert.equal(counts.terminal, false);
    assert.equal(counts.dormant, 1);
  });

  it('never calls a partially-fetched project terminal: its unfetched tickets are invisible, not absent', () => {
    const graph = derive(
      snapshot({
        projects: [{id: 'P', name: 'Project', declared: true}],
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

    const dangling = graph.anomalies.filter(
      (anomaly) => anomaly.kind === 'dangling-edge'
    );
    assert.equal(dangling.length, 2);
    assert.match(
      String(dangling[0]?.detail),
      /held blocked until GHOST is fetched/
    );
    assert.match(String(dangling[1]?.detail), /schedules nothing/);
  });

  it('surfaces two projects that block each other', () => {
    const graph = derive(
      snapshot({
        projects: [
          {id: 'P', name: 'P', declared: true},
          {id: 'Q', name: 'Q', declared: true},
        ],
        nodes: [
          node('P1', {project: 'P'}),
          node('Q1', {project: 'Q'}),
          node('P2', {project: 'P'}),
          node('Q2', {project: 'Q'}),
        ],
        edges: [edge('P1', 'Q1'), edge('Q2', 'P2')],
      })
    );

    const reverse = graph.anomalies.filter(
      (anomaly) => anomaly.kind === 'cross-project-reverse'
    );
    assert.equal(reverse.length, 1);
    assert.deepEqual(reverse[0]?.nodes, ['P1', 'P2', 'Q1', 'Q2']);
  });

  it('surfaces a ticket in a milestone the fetch never returned, which escapes the gate', () => {
    const graph = derive(
      snapshot({nodes: [node('A', {milestone: 'ghost-milestone'})]})
    );

    const anomaly = graph.anomalies[0];
    assert.ok(anomaly);
    assert.equal(anomaly.kind, 'unknown-milestone');
    assert.deepEqual(anomaly.nodes, ['A']);
  });
});
