import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { analyzeBlocking } from './blocking.mts';
import {
  computeMilestoneStates,
  fingerprintMembers,
  gatingMilestones,
} from './milestones.mts';
import { edge, node } from './test-support.mts';
import type {
  GraphEdge,
  GraphNode,
  Milestone,
  ReviewRecord,
} from './types.mts';

const M1: Milestone = { id: 'm1', project: 'p1', name: 'M1', sortOrder: 1 };
const M2: Milestone = { id: 'm2', project: 'p1', name: 'M2', sortOrder: 2 };

function states(
  nodes: GraphNode[],
  reviews: ReviewRecord[] = [],
  edges: GraphEdge[] = [],
  milestones: Milestone[] = [M1, M2],
) {
  return computeMilestoneStates(
    nodes,
    milestones,
    reviews,
    analyzeBlocking(nodes, edges),
  );
}

function review(milestone: string, memberIds: string[]): ReviewRecord {
  return {
    milestone,
    fingerprint: fingerprintMembers(memberIds),
    recordedAt: '2026-07-11T00:00:00.000Z',
  };
}

describe('milestone readiness', () => {
  it('is ready for review only when every member is resolved', () => {
    const open = states([
      node('A', 'verified', { milestone: 'm1' }),
      node('B', 'in-review', { milestone: 'm1' }),
    ]);
    assert.equal(open.get('m1')?.readyForReview, false);
    assert.equal(open.get('m1')?.openCount, 1);

    const done = states([
      node('A', 'verified', { milestone: 'm1' }),
      node('B', 'canceled', { milestone: 'm1' }),
    ]);
    assert.equal(done.get('m1')?.readyForReview, true);
    assert.equal(done.get('m1')?.openCount, 0);
  });

  it('is not ready while an outside ticket a member depends on is still open', () => {
    // Every member is done, but a member depends on an unresolved ticket in
    // another milestone — the milestone still has a blocker.
    const nodes = [
      node('OUTSIDE', 'in-progress', { milestone: 'm2' }),
      node('A', 'verified', { milestone: 'm1' }),
    ];
    const result = states(nodes, [], [edge('OUTSIDE > A')]);

    assert.equal(result.get('m1')?.readyForReview, false);
  });

  it('is never ready when it holds no tickets', () => {
    // An empty milestone has nothing to review. Calling it "reviewed" would let
    // it gate every later milestone forever.
    const result = states([node('A', 'available', { milestone: 'm2' })]);

    assert.equal(result.get('m1')?.memberCount, 0);
    assert.equal(result.get('m1')?.readyForReview, false);
  });
});

describe('review records', () => {
  it('counts a review recorded against the current member set', () => {
    const nodes = [node('A', 'verified', { milestone: 'm1' })];
    const result = states(nodes, [review('m1', ['A'])]);

    assert.equal(result.get('m1')?.reviewRecorded, true);
  });

  it('drops back to unreviewed when the review files a follow-up ticket', () => {
    // The protocol requires a fresh review after follow-up work lands in the
    // milestone. The recorded review is pinned to the member set it covered, so
    // adding B invalidates it — a stale record cannot suppress the re-review.
    const before = [node('A', 'verified', { milestone: 'm1' })];
    const recorded = review('m1', ['A']);
    assert.equal(states(before, [recorded]).get('m1')?.reviewRecorded, true);

    const after = [
      node('A', 'verified', { milestone: 'm1' }),
      node('B', 'available', { milestone: 'm1' }), // filed by the review
    ];
    const result = states(after, [recorded]);

    assert.equal(result.get('m1')?.reviewRecorded, false);
    assert.equal(result.get('m1')?.readyForReview, false); // B is open again
  });

  it("does not count another milestone's review", () => {
    const nodes = [node('A', 'verified', { milestone: 'm1' })];
    const result = states(nodes, [review('m2', ['A'])]);

    assert.equal(result.get('m1')?.reviewRecorded, false);
  });
});

describe('milestone gating', () => {
  it('gates a ticket behind an earlier milestone that is not yet reviewed', () => {
    const nodes = [
      node('A', 'verified', { milestone: 'm1' }),
      node('B', 'available', { milestone: 'm2' }),
    ];
    const result = states(nodes);

    // m1 is complete but nobody has reviewed it, so m2 cannot start.
    assert.equal(result.get('m1')?.readyForReview, true);
    assert.equal(result.get('m1')?.reviewRecorded, false);
    assert.deepEqual(gatingMilestones(nodes[1] as GraphNode, result), ['m1']);
  });

  it('opens the gate once the earlier milestone is reviewed', () => {
    const nodes = [
      node('A', 'verified', { milestone: 'm1' }),
      node('B', 'available', { milestone: 'm2' }),
    ];
    const result = states(nodes, [review('m1', ['A'])]);

    assert.deepEqual(gatingMilestones(nodes[1] as GraphNode, result), []);
  });

  it('does not gate on an empty earlier milestone', () => {
    const nodes = [node('B', 'available', { milestone: 'm2' })];
    const result = states(nodes);

    assert.deepEqual(gatingMilestones(nodes[0] as GraphNode, result), []);
  });

  it('does not gate on a later milestone, or across projects', () => {
    const other = { id: 'x1', project: 'p2', name: 'X1', sortOrder: 0 };
    const nodes = [
      node('A', 'available', { milestone: 'm1' }),
      node('B', 'available', { milestone: 'm2' }),
      node('X', 'available', { project: 'p2', milestone: 'x1' }),
    ];
    const result = states(nodes, [], [], [M1, M2, other]);

    // A is in the earliest milestone: nothing gates it. The other project's
    // unreviewed milestone is not its concern.
    assert.deepEqual(gatingMilestones(nodes[0] as GraphNode, result), []);
    // B is gated by m1 only — not by p2's x1, despite x1 sorting earlier.
    assert.deepEqual(gatingMilestones(nodes[1] as GraphNode, result), ['m1']);
  });

  it('does not gate a ticket with no milestone', () => {
    const nodes = [
      node('A', 'available', { milestone: 'm1' }),
      node('LOOSE', 'available'),
    ];
    const result = states(nodes);

    assert.deepEqual(gatingMilestones(nodes[1] as GraphNode, result), []);
  });
});
