import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {analyzeBlocking} from './blocking.mts';
import {
  computeMilestoneStates,
  fingerprintMembers,
  gatingMilestones,
  milestoneAncestry,
  type MilestoneState,
} from './milestones.mts';
import {edge, node} from './test-support.mts';
import type {GraphEdge, GraphNode, Milestone, ReviewRecord} from './types.mts';

const M1: Milestone = {id: 'm1', project: 'P', name: 'One'};
const M2: Milestone = {id: 'm2', project: 'P', name: 'Two'};

function states(
  nodes: GraphNode[],
  milestones: Milestone[] = [M1, M2],
  reviews: ReviewRecord[] = [],
  taskEdges: GraphEdge[] = []
): Map<string, MilestoneState> {
  return computeMilestoneStates(
    nodes,
    milestones,
    reviews,
    analyzeBlocking(nodes, taskEdges)
  );
}

function review(milestone: string, members: string[]): ReviewRecord {
  return {
    milestone,
    fingerprint: fingerprintMembers(members),
    recordedAt: '2026-07-01T00:00:00.000Z',
  };
}

describe('ready for review', () => {
  it('is false while any member is open', () => {
    const state = states([
      node('A', {milestone: 'm1', role: 'verified'}),
      node('B', {milestone: 'm1', role: 'in-progress'}),
    ]).get('m1');
    assert.ok(state);

    assert.equal(state.readyForReview, false);
    assert.equal(state.openCount, 1);
  });

  it('is true once every member is verified or canceled', () => {
    const state = states([
      node('A', {milestone: 'm1', role: 'verified'}),
      node('B', {milestone: 'm1', role: 'canceled'}),
    ]).get('m1');
    assert.ok(state);

    assert.equal(state.readyForReview, true);
  });

  it('is false while a member still has an unresolved dependency', () => {
    const nodes = [
      node('OUT', {milestone: null, role: 'in-progress'}),
      node('A', {milestone: 'm1', role: 'verified'}),
    ];
    const state = states(nodes, [M1, M2], [], [edge('OUT', 'A')]).get('m1');
    assert.ok(state);

    assert.equal(state.readyForReview, false);
  });

  it('is false for an empty milestone: there is nothing to review', () => {
    const state = states([node('A', {milestone: 'm2'})]).get('m1');
    assert.ok(state);

    assert.equal(state.memberCount, 0);
    assert.equal(state.readyForReview, false);
  });

  it('is false while a member that cannot progress is still open', () => {
    // A ticket nobody can finish is still open, so its milestone is not complete
    // (§2.3). Cancelling it is how a human resolves it — nothing is inferred.
    const state = states([
      node('A', {milestone: 'm1', role: 'verified'}),
      node('DEAD', {milestone: 'm1', role: 'in-progress'}),
    ]).get('m1');
    assert.ok(state);

    assert.equal(state.readyForReview, false);
  });
});

describe('review records', () => {
  it('counts a review of the current member set as recorded', () => {
    const nodes = [node('A', {milestone: 'm1', role: 'verified'})];
    const state = states(nodes, [M1], [review('m1', ['A'])]).get('m1');
    assert.ok(state);

    assert.equal(state.reviewRecorded, true);
  });

  it('stops counting it once the review files a follow-up task into the milestone', () => {
    const nodes = [
      node('A', {milestone: 'm1', role: 'verified'}),
      node('FOLLOWUP', {milestone: 'm1', role: 'verified'}),
    ];
    const state = states(nodes, [M1], [review('m1', ['A'])]).get('m1');
    assert.ok(state);

    assert.equal(state.readyForReview, true);
    assert.equal(state.reviewRecorded, false);
  });

  it('stops counting it when a member moved after the review was recorded', () => {
    const nodes = [
      node('A', {
        milestone: 'm1',
        role: 'verified',
        updatedAt: '2026-07-02T00:00:00.000Z',
      }),
    ];
    const state = states(nodes, [M1], [review('m1', ['A'])]).get('m1');
    assert.ok(state);

    assert.equal(state.reviewRecorded, false);
  });

  it('compares timestamps by instant, not lexically, across timezone offsets', () => {
    // The member moved at 05:30Z, after the 04:00Z review, but "00:30" sorts
    // before "04:00" as a string. Only a real time comparison catches it.
    const reviewRec = {
      milestone: 'm1',
      fingerprint: fingerprintMembers(['A']),
      recordedAt: '2026-07-02T04:00:00.000Z',
    };
    const nodes = [
      node('A', {
        milestone: 'm1',
        role: 'verified',
        updatedAt: '2026-07-02T00:30:00.000-05:00',
      }),
    ];
    const state = states(nodes, [M1], [reviewRec]).get('m1');
    assert.ok(state);

    assert.equal(state.reviewRecorded, false);
  });
});

describe('the milestone gate over edges', () => {
  const ancestry = (edges: GraphEdge[]): Map<string, Set<string>> =>
    milestoneAncestry([M1, M2], edges);

  it('gates a task in a later milestone until the earlier one is reviewed', () => {
    const nodes = [
      node('A', {milestone: 'm1', role: 'verified'}),
      node('B', {milestone: 'm2', role: 'available'}),
    ];
    const map = states(nodes, [M1, M2]);
    const b = nodes[1];
    assert.ok(b);

    // m1 blocks m2; m1 ready but unreviewed → gate holds.
    assert.deepEqual(gatingMilestones(b, map, ancestry([edge('m1', 'm2')])), [
      'm1',
    ]);
  });

  it('opens the gate once the earlier milestone is both ready and reviewed', () => {
    const nodes = [
      node('A', {milestone: 'm1', role: 'verified'}),
      node('B', {milestone: 'm2', role: 'available'}),
    ];
    const map = states(nodes, [M1, M2], [review('m1', ['A'])]);
    const b = nodes[1];
    assert.ok(b);

    assert.deepEqual(
      gatingMilestones(b, map, ancestry([edge('m1', 'm2')])),
      []
    );
  });

  it('honors multiple predecessors', () => {
    const m3: Milestone = {id: 'm3', project: 'P', name: 'Three'};
    const nodes = [
      node('A', {milestone: 'm1', role: 'verified'}),
      node('B', {milestone: 'm2', role: 'verified'}),
      node('C', {milestone: 'm3', role: 'available'}),
    ];
    const map = computeMilestoneStates(
      nodes,
      [M1, M2, m3],
      [review('m1', ['A'])],
      analyzeBlocking(nodes, [])
    );
    const c = nodes[2];
    assert.ok(c);

    // m3 blocked by m1 (reviewed) and m2 (not reviewed) → only m2 gates.
    const anc = milestoneAncestry(
      [M1, M2, m3],
      [edge('m1', 'm3'), edge('m2', 'm3')]
    );
    assert.deepEqual(gatingMilestones(c, map, anc), ['m2']);
  });

  it('does not gate a milestone with no members, which carries no work', () => {
    const nodes = [node('B', {milestone: 'm2', role: 'available'})];
    const b = nodes[0];
    assert.ok(b);

    // m1 blocks m2 but m1 is empty → no gate.
    assert.deepEqual(
      gatingMilestones(
        b,
        states(nodes, [M1, M2]),
        ancestry([edge('m1', 'm2')])
      ),
      []
    );
  });
});
