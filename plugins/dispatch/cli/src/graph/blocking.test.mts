import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { analyzeBlocking, isEffectivelyBlocked } from './blocking.mts';
import { edge, node } from './test-support.mts';

describe('effective blocking', () => {
  it('blocks a ticket transitively, through a chain of open ancestors', () => {
    const nodes = [
      node('A', 'in-progress'),
      node('B', 'available'),
      node('C', 'available'),
    ];
    const analysis = analyzeBlocking(nodes, [edge('A > B'), edge('B > C')]);

    assert.equal(isEffectivelyBlocked(analysis, 'A'), false);
    assert.deepEqual(analysis.unresolvedAncestors.get('B'), ['A']);
    // C's only direct blocker is B, but A sits behind B and is still open.
    assert.deepEqual(analysis.unresolvedAncestors.get('C'), ['A', 'B']);
  });

  it('stops blocking once an ancestor is verified', () => {
    const nodes = [node('A', 'verified'), node('B', 'available')];
    const analysis = analyzeBlocking(nodes, [edge('A > B')]);

    assert.equal(isEffectivelyBlocked(analysis, 'B'), false);
  });

  it('treats a canceled ancestor as unblocking, not as a permanent block', () => {
    // The protocol is explicit: cancellation releases downstream work. A
    // dependent of a canceled ticket becomes workable, it does not get stranded.
    const nodes = [node('A', 'canceled'), node('B', 'available')];
    const analysis = analyzeBlocking(nodes, [edge('A > B')]);

    assert.equal(isEffectivelyBlocked(analysis, 'B'), false);
  });

  it('releases a dependent when its blocker is canceled, even if work sits behind it', () => {
    // The rule the protocol states outright: cancellation UNBLOCKS downstream
    // work. C depended on A; A was abandoned. Walking past the canceled A into
    // its own still-open blocker B would strand C forever on work nobody will
    // ever do — the one outcome the protocol forbids.
    const nodes = [
      node('B', 'in-progress'),
      node('A', 'canceled'),
      node('C', 'available'),
    ];
    const analysis = analyzeBlocking(nodes, [edge('B > A'), edge('A > C')]);

    assert.deepEqual(analysis.unresolvedAncestors.get('C'), []);
    assert.equal(isEffectivelyBlocked(analysis, 'C'), false);
  });

  it('stops the walk at a verified ancestor that is itself still blocked', () => {
    // The tracker says A is done. That judgment is authoritative over whatever
    // is still open behind it, so B is free to start.
    const nodes = [
      node('Z', 'in-progress'),
      node('A', 'verified'),
      node('B', 'available'),
    ];
    const analysis = analyzeBlocking(nodes, [edge('Z > A'), edge('A > B')]);

    assert.deepEqual(analysis.unresolvedAncestors.get('B'), []);
    // A is still an ancestor, it just is not a blocking one.
    assert.ok(analysis.ancestors.get('B')?.has('A'));
  });

  it('reports a cycle and leaves every ticket on it blocked', () => {
    const nodes = [
      node('A', 'available'),
      node('B', 'available'),
      node('C', 'available'),
    ];
    const analysis = analyzeBlocking(nodes, [
      edge('A > B'),
      edge('B > C'),
      edge('C > A'),
    ]);

    assert.equal(analysis.cycles.length, 1);
    assert.deepEqual([...(analysis.cycles[0] ?? [])].sort(), ['A', 'B', 'C']);

    // Each ticket on the cycle is its own ancestor, so all three are blocked
    // with no special-casing — and none can ever be dispatched.
    for (const id of ['A', 'B', 'C']) {
      assert.equal(
        isEffectivelyBlocked(analysis, id),
        true,
        `${id} should be blocked`,
      );
    }
  });

  it('reports a self-dependency as a cycle', () => {
    const analysis = analyzeBlocking([node('A', 'available')], [edge('A > A')]);

    assert.deepEqual(analysis.cycles, [['A']]);
    assert.equal(isEffectivelyBlocked(analysis, 'A'), true);
  });

  it('does not invent a cycle for a diamond', () => {
    // A blocks B and C; both block D. Every path is acyclic, and a DFS that
    // mishandles re-visiting a finished node would report a false cycle here.
    const nodes = ['A', 'B', 'C', 'D'].map((id) => node(id, 'available'));
    const analysis = analyzeBlocking(nodes, [
      edge('A > B'),
      edge('A > C'),
      edge('B > D'),
      edge('C > D'),
    ]);

    assert.deepEqual(analysis.cycles, []);
    assert.deepEqual(analysis.unresolvedAncestors.get('D'), ['A', 'B', 'C']);
  });

  it('blocks a ticket whose blocker was never fetched, and flags the gap', () => {
    // An edge to a ticket outside the graph means the fetch was incomplete.
    // Reading that as "unblocked" would dispatch work whose real blocker is
    // invisible, so the dependent is held and the gap is surfaced.
    const analysis = analyzeBlocking(
      [node('B', 'available')],
      [edge('GHOST > B')],
    );

    assert.deepEqual(analysis.danglingEdges, [
      { blocker: 'GHOST', blocked: 'B' },
    ]);
    assert.deepEqual(analysis.unresolvedAncestors.get('B'), ['GHOST']);
    assert.equal(isEffectivelyBlocked(analysis, 'B'), true);
  });

  it('holds a ticket whose own blocker was never fetched, but not those behind it', () => {
    // A's blocker was never fetched, so A itself is held — an unknown blocker is
    // not an absent one. But A is `available`, not resolved, so B is blocked by
    // A anyway; the unfetched GHOST reaches B through A because A is a live link
    // in the chain.
    const nodes = [node('A', 'available'), node('B', 'available')];
    const analysis = analyzeBlocking(nodes, [edge('GHOST > A'), edge('A > B')]);

    assert.deepEqual(analysis.unresolvedAncestors.get('A'), ['GHOST']);
    assert.deepEqual(analysis.unresolvedAncestors.get('B'), ['A', 'GHOST']);
    assert.equal(isEffectivelyBlocked(analysis, 'B'), true);
  });

  it('counts transitive descendants, for ranking by how much work a ticket unblocks', () => {
    const nodes = ['A', 'B', 'C', 'D'].map((id) => node(id, 'available'));
    const analysis = analyzeBlocking(nodes, [
      edge('A > B'),
      edge('B > C'),
      edge('B > D'),
    ]);

    assert.equal(analysis.descendantCount.get('A'), 3);
    assert.equal(analysis.descendantCount.get('B'), 2);
    assert.equal(analysis.descendantCount.get('C'), 0);
  });
});
