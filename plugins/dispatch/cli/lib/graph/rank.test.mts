import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {analyzeBlocking} from './blocking.mts';
import {rankAvailable} from './rank.mts';
import {edge, node} from './test-support.mts';
import type {GraphEdge, GraphNode} from './types.mts';

function order(nodes: GraphNode[], edges: GraphEdge[] = []): string[] {
  return rankAvailable(nodes, analyzeBlocking(nodes, edges)).map(
    (entry) => entry.id
  );
}

describe('ranking the frontier', () => {
  it('puts injected work at the top, however low its priority', () => {
    const nodes = [
      node('A', {priority: 1}),
      node('INJECTED', {priority: 4, injected: true}),
    ];

    assert.deepEqual(order(nodes), ['INJECTED', 'A']);
  });

  it('takes the more urgent priority first, and sorts an absent priority last', () => {
    const nodes = [
      node('A', {priority: null}),
      node('B', {priority: 3}),
      node('C', {priority: 1}),
    ];

    assert.deepEqual(order(nodes), ['C', 'B', 'A']);
  });

  it('breaks a priority tie by how much downstream work the ticket unblocks', () => {
    // This is what keeps the critical path moving instead of finishing leaves.
    const nodes = [
      node('LEAF', {priority: 2}),
      node('GATE', {priority: 2}),
      node('X'),
      node('Y'),
    ];
    const edges = [edge('GATE', 'X'), edge('X', 'Y')];

    assert.deepEqual(order(nodes, edges).slice(0, 2), ['GATE', 'LEAF']);
  });

  it('is deterministic when everything else ties', () => {
    const nodes = [node('B'), node('A'), node('C')];

    assert.deepEqual(order(nodes), ['A', 'B', 'C']);
  });
});
