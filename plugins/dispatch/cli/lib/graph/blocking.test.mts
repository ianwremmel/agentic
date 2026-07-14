import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {analyzeBlocking, isEffectivelyBlocked} from './blocking.mts';
import {edge, node} from './test-support.mts';

describe('effective blocking', () => {
  it('blocks through a chain of open ancestors, not just the direct one', () => {
    const analysis = analyzeBlocking(
      [node('A'), node('B'), node('C')],
      [edge('A', 'B'), edge('B', 'C')]
    );

    assert.deepEqual(analysis.unresolvedAncestors.get('C'), ['A', 'B']);
    assert.equal(isEffectivelyBlocked(analysis, 'C'), true);
    assert.equal(isEffectivelyBlocked(analysis, 'A'), false);
  });

  it('releases a dependent when its blocker is canceled, and does not inherit the blockers behind it', () => {
    // The rule that matters most: cancellation unblocks downstream work. If the
    // walk continued past the canceled ticket, C would stay blocked forever on
    // A — work that was abandoned.
    const analysis = analyzeBlocking(
      [node('A'), node('B', {role: 'canceled'}), node('C')],
      [edge('A', 'B'), edge('B', 'C')]
    );

    assert.deepEqual(analysis.unresolvedAncestors.get('C'), []);
    assert.equal(isEffectivelyBlocked(analysis, 'C'), false);
  });

  it('treats a verified ancestor the same way', () => {
    const analysis = analyzeBlocking(
      [node('A'), node('B', {role: 'verified'}), node('C')],
      [edge('A', 'B'), edge('B', 'C')]
    );

    assert.equal(isEffectivelyBlocked(analysis, 'C'), false);
  });

  it('holds a ticket blocked behind a blocker the fetch never returned', () => {
    // An unfetched blocker has no role, so it cannot be shown to be resolved.
    // Offering the dependent up as available would dispatch work whose blocker
    // nobody has ever seen.
    const analysis = analyzeBlocking([node('B')], [edge('MISSING', 'B')]);

    assert.deepEqual(analysis.unresolvedAncestors.get('B'), ['MISSING']);
    assert.deepEqual(analysis.danglingEdges, [edge('MISSING', 'B')]);
  });

  it('reports an edge whose dependent is missing, but hangs nothing on it', () => {
    const analysis = analyzeBlocking([node('A')], [edge('A', 'MISSING')]);

    assert.deepEqual(analysis.danglingEdges, [edge('A', 'MISSING')]);
    assert.equal(analysis.descendantCount.get('A'), 0);
  });

  it('counts transitive descendants, which is what ranking uses to find the critical path', () => {
    const analysis = analyzeBlocking(
      [node('A'), node('B'), node('C'), node('D')],
      [edge('A', 'B'), edge('B', 'C'), edge('A', 'D')]
    );

    assert.equal(analysis.descendantCount.get('A'), 3);
    assert.equal(analysis.descendantCount.get('B'), 1);
    assert.equal(analysis.descendantCount.get('C'), 0);
  });
});

describe('cycles', () => {
  it('detects a cycle and reports it once', () => {
    const analysis = analyzeBlocking(
      [node('A'), node('B'), node('C')],
      [edge('A', 'B'), edge('B', 'C'), edge('C', 'A')]
    );

    assert.equal(analysis.cycles.length, 1);
    assert.deepEqual([...(analysis.cycles[0] ?? [])].sort(), ['A', 'B', 'C']);
  });

  it('blocks every ticket on a cycle: each is its own unresolved ancestor', () => {
    const analysis = analyzeBlocking(
      [node('A'), node('B')],
      [edge('A', 'B'), edge('B', 'A')]
    );

    assert.equal(isEffectivelyBlocked(analysis, 'A'), true);
    assert.equal(isEffectivelyBlocked(analysis, 'B'), true);
  });

  it('detects a self-edge as the one-node cycle it is', () => {
    const analysis = analyzeBlocking([node('A')], [edge('A', 'A')]);

    assert.deepEqual(analysis.cycles, [['A']]);
    assert.equal(isEffectivelyBlocked(analysis, 'A'), true);
  });

  it('does not mistake a diamond for a cycle', () => {
    const analysis = analyzeBlocking(
      [node('A'), node('B'), node('C'), node('D')],
      [edge('A', 'B'), edge('A', 'C'), edge('B', 'D'), edge('C', 'D')]
    );

    assert.deepEqual(analysis.cycles, []);
    assert.deepEqual(analysis.unresolvedAncestors.get('D'), ['A', 'B', 'C']);
  });

  it('survives a long chain without blowing the stack', () => {
    const ids = Array.from({length: 5000}, (_, index) => `T${String(index)}`);
    const nodes = ids.map((id) => node(id));
    const edges = ids.slice(1).map((id, index) => edge(ids[index] ?? '', id));

    const analysis = analyzeBlocking(nodes, edges);

    assert.equal(analysis.unresolvedAncestors.get('T4999')?.length, 4999);
  });
});
