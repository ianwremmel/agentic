import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {analyzeBlocking} from './blocking.mts';
import {
  computeMilestoneStates,
  fingerprintMembers,
  gatingMilestones,
  type MilestoneState,
} from './milestones.mts';
import {edge, node} from './test-support.mts';
import type {GraphEdge, GraphNode, Milestone, ReviewRecord} from './types.mts';

const M1: Milestone = {id: 'm1', project: 'P', name: 'One', sortOrder: 1};
const M2: Milestone = {id: 'm2', project: 'P', name: 'Two', sortOrder: 2};

function states(
  nodes: GraphNode[],
  milestones: Milestone[] = [M1, M2],
  reviews: ReviewRecord[] = [],
  edges: GraphEdge[] = []
): Map<string, MilestoneState> {
  return computeMilestoneStates(
    nodes,
    milestones,
    reviews,
    analyzeBlocking(nodes, edges)
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

  it('is false while a member still has an unresolved dependency outside the milestone', () => {
    // §2.3: no unresolved ticket may be a dependency of a milestone member.
    const nodes = [
      node('OUT', {milestone: null, role: 'in-progress'}),
      node('A', {milestone: 'm1', role: 'verified'}),
    ];
    const state = states(nodes, [M1, M2], [], [edge('OUT', 'A')]).get('m1');

    assert.ok(state);

    assert.equal(state.readyForReview, false);
  });

  it('is false for an empty milestone: there is nothing to review', () => {
    // Calling an empty milestone reviewed would let it gate every later
    // milestone forever.
    const state = states([node('A', {milestone: 'm2'})]).get('m1');

    assert.ok(state);

    assert.equal(state.memberCount, 0);
    assert.equal(state.readyForReview, false);
  });

  it('is false while a ticket that cannot progress is still open: the milestone is not complete', () => {
    // A ticket nobody can finish is still an open ticket. The producer must not
    // infer that dead work is done — deciding to give up is a human's call.
    const nodes = [
      node('A', {milestone: 'm1', role: 'verified'}),
      node('DEAD', {milestone: 'm1', role: 'in-progress'}),
    ];
    const state = states(nodes, [M1]).get('m1');

    assert.ok(state);

    assert.equal(state.readyForReview, false);
    assert.equal(state.openCount, 1);
  });

  it('is true once that ticket is canceled — how a human resolves work that will not be done', () => {
    // Cancelling settles the ticket AND releases whatever it blocked, which is
    // why nothing else in the graph needs a special case for dead work.
    const nodes = [
      node('A', {milestone: 'm1', role: 'verified'}),
      node('DEAD', {milestone: 'm1', role: 'canceled'}),
    ];
    const state = states(nodes, [M1]).get('m1');

    assert.ok(state);

    assert.equal(state.readyForReview, true);
    assert.equal(state.openCount, 0);
  });
});

describe('review records', () => {
  it('counts a review of the current member set as recorded', () => {
    const nodes = [node('A', {milestone: 'm1', role: 'verified'})];
    const state = states(nodes, [M1], [review('m1', ['A'])]).get('m1');

    assert.ok(state);

    assert.equal(state.reviewRecorded, true);
  });

  it('stops counting it once the review files a follow-up ticket into the milestone', () => {
    // §2.6: a review that files follow-up work re-opens the milestone, and the
    // next completion needs a fresh review. The old record covers a member set
    // that no longer exists.
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
    // A member reopened and re-verified between two syncs leaves the member set
    // identical, and the graph never observes the milestone as un-ready — so the
    // ids alone cannot see it. The tracker's updatedAt can: it moved.
    const nodes = [
      node('A', {
        milestone: 'm1',
        role: 'verified',
        updatedAt: '2026-07-02T00:00:00.000Z',
      }),
    ];
    const state = states(nodes, [M1], [review('m1', ['A'])]).get('m1');
    assert.ok(state);

    assert.equal(state.readyForReview, true);
    assert.equal(state.reviewRecorded, false);
  });

  it('keeps the review when the member has not moved since', () => {
    const nodes = [
      node('A', {
        milestone: 'm1',
        role: 'verified',
        updatedAt: '2026-06-01T00:00:00.000Z',
      }),
    ];
    const state = states(nodes, [M1], [review('m1', ['A'])]).get('m1');
    assert.ok(state);

    assert.equal(state.reviewRecorded, true);
  });

  it('does not let one milestone review satisfy another', () => {
    const nodes = [
      node('A', {milestone: 'm1', role: 'verified'}),
      node('B', {milestone: 'm2', role: 'verified'}),
    ];
    const map = states(nodes, [M1, M2], [review('m1', ['A'])]);

    assert.equal(map.get('m1')?.reviewRecorded, true);
    assert.equal(map.get('m2')?.reviewRecorded, false);
  });
});

describe('the milestone gate', () => {
  it('gates a later milestone until the earlier one is reviewed', () => {
    const nodes = [
      node('A', {milestone: 'm1', role: 'verified'}),
      node('B', {milestone: 'm2', role: 'available'}),
    ];
    const map = states(nodes, [M1, M2]);
    const b = nodes[1];
    assert.ok(b);

    // Ready, but nobody has reviewed it: the gate holds.
    assert.deepEqual(gatingMilestones(b, map), ['m1']);
  });

  it('opens the gate once the earlier milestone is both ready and reviewed', () => {
    const nodes = [
      node('A', {milestone: 'm1', role: 'verified'}),
      node('B', {milestone: 'm2', role: 'available'}),
    ];
    const map = states(nodes, [M1, M2], [review('m1', ['A'])]);
    const b = nodes[1];
    assert.ok(b);

    assert.deepEqual(gatingMilestones(b, map), []);
  });

  it('does not gate on an empty milestone, which carries no work', () => {
    const nodes = [node('B', {milestone: 'm2', role: 'available'})];
    const b = nodes[0];
    assert.ok(b);

    assert.deepEqual(gatingMilestones(b, states(nodes, [M1, M2])), []);
  });

  it('does not gate across projects: milestone order is project-local', () => {
    const other: Milestone = {
      id: 'q1',
      project: 'Q',
      name: 'Other',
      sortOrder: 1,
    };
    const nodes = [
      node('X', {project: 'Q', milestone: 'q1', role: 'in-progress'}),
      node('B', {project: 'P', milestone: 'm2', role: 'available'}),
    ];
    const b = nodes[1];
    assert.ok(b);

    assert.deepEqual(gatingMilestones(b, states(nodes, [other, M2])), []);
  });
});
