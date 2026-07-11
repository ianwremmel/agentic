/**
 * Behavioral tests for the derivation.
 *
 * Each case states a scheduling rule and proves the rule holds — what work the
 * orchestrator is handed, and what it is protected from. Several of these encode
 * a bug that shipped once: an empty milestone that deadlocked a run, a
 * `human-only` ticket dispatched to a coordinator, a dropped blocker that made
 * blocked work look ready.
 */

import assert from 'node:assert/strict';
import {test} from 'node:test';

import {derive} from './derive.mts';
import type {Edge, Graph, Milestone, Node, Role} from './types.mts';

/** A workable ticket unless the test says otherwise. */
const node = (id: string, over: Partial<Node> = {}): Node => ({
  id,
  role: 'available' as Role,
  group: 'unstarted',
  project: 'p1',
  target_kind: 'pr',
  ...over,
});

const graph = (nodes: Node[], edges: Edge[] = [], milestones: Milestone[] = []): Graph => ({
  cursor: null,
  projects: [{id: 'p1'}],
  milestones,
  nodes,
  edges,
});

const milestone = (id: string, order: number, over: Partial<Milestone> = {}): Milestone => ({
  id,
  project: 'p1',
  order,
  ...over,
});

test('a ticket whose blocker is still open is not offered for dispatch', () => {
  const doc = derive(graph([node('A', {role: 'in-progress'}), node('B')], [{blocker: 'A', blocked: 'B'}]));
  assert.deepEqual(doc.available, ['A']);
  assert.deepEqual(doc.blocked, ['B']);
});

test('blocking is transitive: an open grandparent still blocks', () => {
  const doc = derive(
    graph(
      [node('A', {role: 'in-progress'}), node('B', {role: 'verified'}), node('C')],
      [
        {blocker: 'A', blocked: 'B'},
        {blocker: 'B', blocked: 'C'},
      ],
    ),
  );
  assert.deepEqual(doc.available, ['A'], 'C is blocked through the verified B by the open A');
  assert.deepEqual(doc.blocked, ['C']);
});

test('canceling a blocker unblocks its dependents rather than killing them', () => {
  const doc = derive(graph([node('A', {role: 'canceled'}), node('B')], [{blocker: 'A', blocked: 'B'}]));
  assert.deepEqual(doc.available, ['B']);
  assert.deepEqual(doc.permanently_blocked, [], 'cancellation is not death');
});

test('a dead blocker permanently blocks everything downstream', () => {
  const doc = derive(
    graph([node('A', {role: 'in-progress', dead: true}), node('B')], [{blocker: 'A', blocked: 'B'}]),
  );
  assert.deepEqual(doc.permanently_blocked, ['A', 'B']);
  assert.deepEqual(doc.available, []);
  assert.equal(doc.counts.terminal, true, 'nothing workable is left, so the run can stop');
});

test('a blocker outside the synced set blocks, and says so', () => {
  const doc = derive(graph([node('B')], [{blocker: 'ELSEWHERE-1', blocked: 'B'}]));
  assert.deepEqual(doc.available, [], 'dropping the edge would report blocked work as ready');
  assert.deepEqual(doc.blocked, ['B']);
  assert.deepEqual(doc.anomalies, [{kind: 'unknown-blocker', node: 'B', blockers: ['ELSEWHERE-1']}]);
});

test('a human-only ticket is never dispatchable, only human-blocked', () => {
  const doc = derive(graph([node('H', {target_kind: 'human-only'}), node('P')]));
  assert.deepEqual(doc.available, ['P']);
  assert.deepEqual(doc.human_blocked, ['H']);
});

test('awaiting-external is a human handoff; paused is not', () => {
  const doc = derive(graph([node('W', {role: 'awaiting-external'}), node('P', {role: 'paused'})]));
  assert.deepEqual(doc.human_blocked, ['W']);
  assert.deepEqual(doc.stalled, ['P'], 'paused means other priorities — alerting a human would be noise');
  assert.deepEqual(doc.available, []);
});

test('backlog tickets are surfaced as stalled, not silently dropped', () => {
  const doc = derive(graph([node('B', {role: 'backlog', group: 'backlog'})]));
  assert.deepEqual(doc.available, []);
  assert.deepEqual(doc.stalled, ['B']);
  assert.equal(doc.counts.terminal, false, 'the run must not report itself complete');
});

test('an unreviewed milestone gates the next one', () => {
  const doc = derive(
    graph(
      [node('A', {milestone: 'm1'}), node('B', {milestone: 'm2'})],
      [],
      [milestone('m1', 1), milestone('m2', 2)],
    ),
  );
  assert.deepEqual(doc.available, ['A']);
  assert.deepEqual(doc.blocked, ['B']);
  assert.equal(doc.nodes.find((n) => n.id === 'B')!.milestone_gate, 'm1');
});

test('the gate opens only once the milestone is both complete and reviewed', () => {
  const complete = [node('A', {role: 'verified', milestone: 'm1'}), node('B', {milestone: 'm2'})];

  const unreviewed = derive(graph(complete, [], [milestone('m1', 1), milestone('m2', 2)]));
  assert.equal(unreviewed.milestones[0]!.ready_for_review, true);
  assert.deepEqual(unreviewed.available, [], 'complete but unreviewed still gates');

  const reviewed = derive(
    graph(complete, [], [milestone('m1', 1, {review_recorded: true}), milestone('m2', 2)]),
  );
  assert.deepEqual(reviewed.available, ['B']);
});

test('an empty milestone gates nothing (it has no review to run)', () => {
  const doc = derive(graph([node('B', {milestone: 'm2'})], [], [milestone('m1', 1), milestone('m2', 2)]));
  assert.deepEqual(doc.available, ['B'], 'gating on an empty milestone would deadlock the project');
});

test('a milestone with an unknown-blocked member is not ready for review', () => {
  const doc = derive(
    graph(
      [node('A', {role: 'verified', milestone: 'm1'})],
      [{blocker: 'ELSEWHERE-1', blocked: 'A'}],
      [milestone('m1', 1)],
    ),
  );
  assert.equal(
    doc.milestones[0]!.ready_for_review,
    false,
    'the gate must not open on top of a dependency anomaly',
  );
});

test('a cycle is reported and its members are withheld from dispatch', () => {
  const doc = derive(
    graph(
      [node('X'), node('Y')],
      [
        {blocker: 'X', blocked: 'Y'},
        {blocker: 'Y', blocked: 'X'},
      ],
    ),
  );
  assert.deepEqual(doc.available, []);
  assert.deepEqual(doc.anomalies, [{kind: 'cycle', nodes: ['X', 'Y']}]);
});

test('mutually dependent projects are reported, however long the loop', () => {
  const doc = derive({
    cursor: null,
    projects: [{id: 'pa'}, {id: 'pb'}, {id: 'pc'}],
    milestones: [],
    nodes: [
      node('A', {project: 'pa'}),
      node('B', {project: 'pb'}),
      node('C', {project: 'pc'}),
      node('D', {project: 'pa'}),
    ],
    edges: [
      {blocker: 'A', blocked: 'B'},
      {blocker: 'B', blocked: 'C'},
      {blocker: 'C', blocked: 'D'},
    ],
  });
  assert.deepEqual(
    doc.anomalies.filter((a) => a.kind === 'cross-project-cycle'),
    [{kind: 'cross-project-cycle', projects: ['pa', 'pb', 'pc']}],
  );
});

test('injected work outranks even a zero-priority ticket', () => {
  const doc = derive(graph([node('AAA', {priority: 0}), node('ZZZ')]), {priority: ['ZZZ']});
  assert.deepEqual(doc.available, ['ZZZ', 'AAA']);
});

test('the frontier ranks whatever unlocks the most work first', () => {
  const doc = derive(
    graph(
      [node('LEAF'), node('TRUNK'), node('DOWNSTREAM')],
      [{blocker: 'TRUNK', blocked: 'DOWNSTREAM'}],
    ),
  );
  assert.deepEqual(doc.available, ['TRUNK', 'LEAF'], 'TRUNK unlocks DOWNSTREAM, so it is worth doing first');
});

test('the frontier never spans a milestone whose predecessor is unreviewed', () => {
  const doc = derive(
    graph(
      [node('EARLY', {milestone: 'm1'}), node('LATE', {milestone: 'm2'})],
      [],
      [milestone('m1', 1), milestone('m2', 2)],
    ),
  );
  assert.deepEqual(doc.available, ['EARLY'], 'm2 cannot start while m1 is open, whatever its rank');
});

test('excluded work leaves the frontier but keeps its place in the graph', () => {
  const doc = derive(graph([node('A'), node('B')]), {exclude: ['A']});
  assert.deepEqual(doc.available, ['B']);
  assert.ok(
    doc.nodes.some((n) => n.id === 'A'),
    'an in-flight ticket must still be visible, or the cache goes stale',
  );
  assert.equal(doc.counts.remaining, 2);
});

test('completion is per project, not just overall', () => {
  const doc = derive({
    cursor: null,
    projects: [{id: 'done'}, {id: 'busy'}],
    milestones: [],
    nodes: [node('A', {role: 'verified', project: 'done'}), node('B', {project: 'busy'})],
    edges: [],
  });
  assert.equal(doc.projects.find((p) => p.id === 'done')!.counts.terminal, true);
  assert.equal(doc.projects.find((p) => p.id === 'busy')!.counts.terminal, false);
  assert.equal(doc.counts.terminal, false);
});

test('a diamond counts each descendant once', () => {
  const doc = derive(
    graph([node('ROOT'), node('L'), node('R'), node('TIP')], [
      {blocker: 'ROOT', blocked: 'L'},
      {blocker: 'ROOT', blocked: 'R'},
      {blocker: 'L', blocked: 'TIP'},
      {blocker: 'R', blocked: 'TIP'},
    ]),
  );
  assert.equal(doc.nodes.find((n) => n.id === 'ROOT')!.unlocks, 3, 'L, R, TIP — TIP is not double-counted');
});
