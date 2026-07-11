/**
 * Behavioral tests for the cache merge.
 *
 * The merge is where the graph either keeps up with the tracker or quietly goes
 * stale. Each case proves what a delta does to the cache — especially the cases
 * where doing nothing would leave a lie behind.
 */

import assert from 'node:assert/strict';
import {test} from 'node:test';

import {EMPTY, merge} from './merge.mts';
import type {Graph} from './types.mts';

const seed = (): Graph => ({
  cursor: 'T1',
  projects: [{id: 'p1'}],
  milestones: [{id: 'm1', project: 'p1', order: 1}],
  nodes: [
    {id: 'A', role: 'verified', title: 'first'},
    {id: 'B', role: 'available'},
  ],
  edges: [{blocker: 'A', blocked: 'B'}],
});

// A hand-built Delta cannot express what `readDelta` produces, so the "a partial
// update keeps the node's other attributes" case is proved in pipeline.test.mts,
// across the real parse → merge seam. These tests cover the merge itself.
test('a delta updates the node it names and leaves the others alone', () => {
  const merged = merge(seed(), {nodes: [{id: 'B', role: 'in-progress'}], cursor: 'T2'});
  assert.equal(merged.nodes.find((n) => n.id === 'B')!.role, 'in-progress');
  assert.equal(merged.nodes.find((n) => n.id === 'A')!.title, 'first', 'untouched nodes survive');
  assert.equal(merged.cursor, 'T2');
});

test('a full sync replaces the cache instead of merging into it', () => {
  const merged = merge(seed(), {full: true, nodes: [{id: 'Z', role: 'available'}], cursor: 'T9'});
  assert.deepEqual(
    merged.nodes.map((n) => n.id),
    ['Z'],
    'stale nodes must not survive a full sync',
  );
  assert.deepEqual(merged.edges, []);
});

test('a removed node takes its edges with it', () => {
  const merged = merge(seed(), {nodes: [{id: 'A', role: 'verified', removed: true}]});
  assert.deepEqual(
    merged.nodes.map((n) => n.id),
    ['B'],
  );
  assert.deepEqual(merged.edges, [], 'an edge to a deleted node would dangle forever');
});

test('a dependency deleted in the tracker is deleted from the cache', () => {
  // The adapter restates B's edges in full and lists none: the dependency is gone.
  const merged = merge(seed(), {nodes: [{id: 'B', role: 'available'}], edges: [], edges_for: ['B']});
  assert.deepEqual(merged.edges, [], 'without edges_for, B would stay blocked by a dependency that no longer exists');
});

test('without edges_for, edges only accumulate', () => {
  const merged = merge(seed(), {edges: [{blocker: 'A', blocked: 'C'}]});
  assert.deepEqual(merged.edges, [
    {blocker: 'A', blocked: 'B'},
    {blocker: 'A', blocked: 'C'},
  ]);
});

test('an edge can be removed on its own', () => {
  const merged = merge(seed(), {edges: [{blocker: 'A', blocked: 'B', removed: true}]});
  assert.deepEqual(merged.edges, []);
});

test('an edge to a node outside the synced set is kept, not pruned', () => {
  const merged = merge(seed(), {edges: [{blocker: 'ELSEWHERE-1', blocked: 'B'}]});
  assert.deepEqual(
    merged.edges,
    [
      {blocker: 'A', blocked: 'B'},
      {blocker: 'ELSEWHERE-1', blocked: 'B'},
    ],
    'derive needs this edge to know B is blocked; pruning it would report B as ready',
  );
});

test('re-adding an edge the delta also restates does not duplicate it', () => {
  const merged = merge(seed(), {edges: [{blocker: 'A', blocked: 'B'}], edges_for: ['B']});
  assert.deepEqual(merged.edges, [{blocker: 'A', blocked: 'B'}]);
});

test('a delta with no cursor leaves the persisted one intact', () => {
  const merged = merge(seed(), {nodes: [{id: 'B', role: 'in-review'}]});
  assert.equal(merged.cursor, 'T1', 'losing the cursor would force a full resync every tick');
});

test('the first fetch builds a cache from nothing', () => {
  const merged = merge(structuredClone(EMPTY), {
    nodes: [{id: 'A', role: 'available'}],
    cursor: 'T1',
  });
  assert.deepEqual(merged.nodes.map((n) => n.id), ['A']);
  assert.equal(merged.cursor, 'T1');
});

test('merging does not mutate the cache it was given', () => {
  const before = seed();
  merge(before, {full: true, nodes: []});
  assert.equal(before.nodes.length, 2, 'a caller re-reading its cache must not see the merge');
});
