import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { derive } from './derive.mts';
import { edge, node, snapshot } from './test-support.mts';

const ids = (entries: { node: { id: string } }[]): string[] =>
  entries.map((entry) => entry.node.id);

describe('classification', () => {
  it('offers only unblocked, available tickets as the frontier', () => {
    const graph = derive(
      snapshot({
        nodes: [
          node('A', 'verified'),
          node('B', 'available'), // unblocked: A is done
          node('C', 'available'), // blocked: D is open
          node('D', 'in-progress'),
          node('E', 'backlog'), // not eligible to be picked up
        ],
        edges: [edge('A > B'), edge('D > C')],
      }),
    );

    assert.deepEqual(ids(graph.available), ['B']);
    assert.deepEqual(ids(graph.blocked), ['C']);
    assert.equal(
      graph.nodes.find((entry) => entry.node.id === 'D')?.classification,
      'in-flight',
    );
    assert.equal(
      graph.nodes.find((entry) => entry.node.id === 'E')?.classification,
      'dormant',
    );
  });

  it('holds a human-interactive ticket back for a human, never for a coordinator', () => {
    const graph = derive(
      snapshot({
        nodes: [
          node('A', 'available', {
            humanInteractive: true,
            targetKind: 'human-only',
          }),
          node('B', 'awaiting-external'), // parked by a coordinator mid-flight
        ],
      }),
    );

    assert.deepEqual(ids(graph.humanBlocked), ['A', 'B']);
    assert.deepEqual(ids(graph.available), []);
  });

  it('does not alert a human about a ticket whose blockers are still open', () => {
    // A human-interactive ticket that is also ancestor-blocked is not yet the
    // human's problem. It reads as `blocked` now, and becomes `human-blocked`
    // the moment its ancestors resolve — so the alert fires once, when it is
    // actually actionable.
    const blocked = derive(
      snapshot({
        nodes: [
          node('DEP', 'in-progress'),
          node('H', 'available', { humanInteractive: true }),
        ],
        edges: [edge('DEP > H')],
      }),
    );
    assert.deepEqual(ids(blocked.blocked), ['H']);
    assert.deepEqual(ids(blocked.humanBlocked), []);

    const resolved = derive(
      snapshot({
        nodes: [
          node('DEP', 'verified'),
          node('H', 'available', { humanInteractive: true }),
        ],
        edges: [edge('DEP > H')],
      }),
    );
    assert.deepEqual(ids(resolved.humanBlocked), ['H']);
  });

  it('permanently blocks the dependents of a failed ticket', () => {
    const graph = derive(
      snapshot({
        nodes: [
          node('DEAD', 'in-progress'),
          node('B', 'available'),
          node('C', 'available'),
        ],
        edges: [edge('DEAD > B'), edge('B > C')],
        exclusions: [{ id: 'DEAD', kind: 'failed' }],
      }),
    );

    // Both the direct dependent and the one behind it can never become
    // available, so neither is reported as merely "blocked" — that would tell
    // the orchestrator to keep waiting for something that will never come.
    assert.deepEqual(ids(graph.permanentlyBlocked).sort(), ['B', 'C', 'DEAD']);
    assert.deepEqual(ids(graph.blocked), []);
    assert.equal(
      graph.permanentlyBlocked.find((entry) => entry.node.id === 'C')
        ?.permanentReason,
      'ancestor-failed:DEAD',
    );
  });

  it('releases dependents of a canceled ticket instead of stranding them', () => {
    const graph = derive(
      snapshot({
        nodes: [node('X', 'canceled'), node('B', 'available')],
        edges: [edge('X > B')],
      }),
    );

    assert.deepEqual(ids(graph.available), ['B']);
    assert.deepEqual(ids(graph.permanentlyBlocked), []);
  });

  it('keeps an in-flight ticket out of the frontier without losing track of it', () => {
    const graph = derive(
      snapshot({
        nodes: [node('A', 'available')],
        exclusions: [{ id: 'A', kind: 'in-flight' }],
      }),
    );

    assert.deepEqual(ids(graph.available), []);
    // Still reported — the orchestrator's cache must not go stale on work a
    // coordinator currently owns.
    assert.equal(graph.nodes.length, 1);
    assert.equal(graph.counts[0]?.inFlight, 1);
    assert.equal(graph.counts[0]?.terminal, false);
  });
});

describe('dormancy', () => {
  it('reports a blocked backlog ticket as dormant, not blocked', () => {
    // A backlog ticket is not eligible to be picked up whatever else is true of
    // it. Calling it `blocked` would promise it becomes workable once DEP lands
    // — it does not; a human has to promote it out of the backlog first.
    const graph = derive(
      snapshot({
        nodes: [node('DEP', 'in-progress'), node('B', 'backlog')],
        edges: [edge('DEP > B')],
      }),
    );

    const entry = graph.nodes.find((candidate) => candidate.node.id === 'B');
    assert.equal(entry?.classification, 'dormant');
    assert.deepEqual(ids(graph.blocked), []);
    // The blocking fact is still reported — it just is not what decides the
    // ticket's bucket.
    assert.equal(entry?.effectiveBlocked, true);
  });

  it('does not alert a human about an unstarted backlog ticket', () => {
    const graph = derive(
      snapshot({ nodes: [node('B', 'backlog', { humanInteractive: true })] }),
    );

    assert.deepEqual(ids(graph.humanBlocked), []);
  });

  it('still parks a paused or awaiting-external ticket with a human', () => {
    // These are parked mid-flight, not un-started. They are the human's problem.
    const graph = derive(
      snapshot({
        nodes: [node('P', 'paused'), node('W', 'awaiting-external')],
      }),
    );

    assert.deepEqual(ids(graph.humanBlocked), ['P', 'W']);
  });
});

describe('effective-blocked', () => {
  it('is a fact about the graph, not a restatement of the bucket', () => {
    // A verified ticket whose own ancestor is still open is effectively blocked
    // even though it buckets as `verified`. Collapsing the two would hide that.
    const graph = derive(
      snapshot({
        nodes: [node('OPEN', 'in-progress'), node('DONE', 'verified')],
        edges: [edge('OPEN > DONE')],
      }),
    );

    const done = graph.nodes.find((entry) => entry.node.id === 'DONE');
    assert.equal(done?.classification, 'verified');
    assert.equal(done?.effectiveBlocked, true);
  });
});

describe('partial projects', () => {
  it('marks a project it only saw through a cross-project ancestor', () => {
    // FOREIGN was pulled in because a selected project's ticket depends on it.
    // Its own project was never fetched, so its counts describe a handful of
    // tickets, not the project — and it can never be called finished.
    const graph = derive(
      snapshot({
        projects: [{ id: 'p1', name: 'Project One', declared: true }],
        nodes: [
          node('A', 'available'),
          node('FOREIGN', 'verified', { project: 'other' }),
        ],
        edges: [edge('FOREIGN > A')],
      }),
    );

    const other = graph.projects.find((project) => project.id === 'other');
    assert.equal(other?.partial, true);
    assert.equal(other?.terminal, false, 'a partial project is never terminal');

    const mine = graph.projects.find((project) => project.id === 'p1');
    assert.equal(mine?.partial, false);
  });
});

describe('completion', () => {
  it('is terminal when every ticket is verified, canceled, or permanently blocked', () => {
    const graph = derive(
      snapshot({
        nodes: [
          node('A', 'verified'),
          node('B', 'canceled'),
          node('DEAD', 'in-progress'),
          node('C', 'available'),
        ],
        edges: [edge('DEAD > C')],
        exclusions: [{ id: 'DEAD', kind: 'failed' }],
      }),
    );

    assert.equal(graph.counts[0]?.terminal, true);
    assert.equal(graph.projects[0]?.terminal, true);
  });

  it('is not terminal while a human still owes an answer', () => {
    const graph = derive(
      snapshot({
        nodes: [node('A', 'verified'), node('H', 'awaiting-external')],
      }),
    );

    assert.equal(graph.counts[0]?.terminal, false);
  });
});

describe('anomalies', () => {
  it('surfaces a cycle rather than scheduling around it', () => {
    const graph = derive(
      snapshot({
        nodes: [node('A', 'available'), node('B', 'available')],
        edges: [edge('A > B'), edge('B > A')],
      }),
    );

    assert.equal(graph.anomalies.length, 1);
    assert.equal(graph.anomalies[0]?.kind, 'cycle');
    assert.deepEqual(ids(graph.available), []);
  });

  it('surfaces two projects that block each other', () => {
    const graph = derive(
      snapshot({
        projects: [
          { id: 'p1', name: 'One', declared: true },
          { id: 'p2', name: 'Two', declared: true },
        ],
        nodes: [
          node('A', 'available', { project: 'p1' }),
          node('B', 'available', { project: 'p2' }),
          node('C', 'available', { project: 'p1' }),
          node('D', 'available', { project: 'p2' }),
        ],
        edges: [edge('A > B'), edge('D > C')],
      }),
    );

    const reverse = graph.anomalies.filter(
      (anomaly) => anomaly.kind === 'cross-project-reverse',
    );
    assert.equal(
      reverse.length,
      1,
      'the pair is reported once, not once per direction',
    );
    assert.deepEqual(reverse[0]?.nodes, ['A', 'B', 'C', 'D']);
  });

  it('says which half of a dangling edge is missing', () => {
    // A missing blocker holds real work back; a missing dependent schedules
    // nothing. Reporting them the same way sends the reader after the wrong
    // ticket.
    const graph = derive(
      snapshot({
        nodes: [node('A', 'available')],
        edges: [edge('GHOST > A'), edge('A > ELSEWHERE')],
      }),
    );

    const details = graph.anomalies
      .filter((anomaly) => anomaly.kind === 'dangling-edge')
      .map((anomaly) => anomaly.detail);

    assert.equal(details.length, 2);
    assert.ok(
      details.some((detail) =>
        /blocker GHOST of A is not in the graph/.test(detail),
      ),
    );
    assert.ok(
      details.some((detail) => /the edge schedules nothing/.test(detail)),
    );
  });

  it('flags a ticket whose milestone was never fetched', () => {
    // Its gate cannot be evaluated, so it escapes milestone sequencing entirely
    // and reads as available. That has to be visible, not silent.
    const graph = derive(
      snapshot({
        nodes: [node('A', 'available', { milestone: 'never-fetched' })],
      }),
    );

    const orphan = graph.anomalies.find(
      (anomaly) => anomaly.kind === 'unknown-milestone',
    );
    assert.ok(orphan, 'expected an unknown-milestone anomaly');
    assert.deepEqual(orphan.nodes, ['A']);
  });

  it('does not flag a one-way cross-project dependency', () => {
    const graph = derive(
      snapshot({
        projects: [
          { id: 'p1', name: 'One', declared: true },
          { id: 'p2', name: 'Two', declared: true },
        ],
        nodes: [
          node('A', 'available', { project: 'p1' }),
          node('B', 'available', { project: 'p2' }),
        ],
        edges: [edge('A > B')],
      }),
    );

    assert.deepEqual(graph.anomalies, []);
  });
});
