import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { derive } from './derive.mts';
import { fingerprintMembers } from './milestones.mts';
import { edge, node, snapshot } from './test-support.mts';
import type { Milestone } from './types.mts';

const M1: Milestone = { id: 'm1', project: 'p1', name: 'M1', sortOrder: 1 };
const M2: Milestone = { id: 'm2', project: 'p1', name: 'M2', sortOrder: 2 };

const order = (graph: { available: { node: { id: string } }[] }): string[] =>
  graph.available.map((entry) => entry.node.id);

describe('frontier ranking', () => {
  it('puts injected work at the top of the frontier', () => {
    const graph = derive(
      snapshot({
        nodes: [
          node('ROUTINE', 'available', { priority: 1 }),
          node('HOTFIX', 'available', { injected: true, priority: 4 }),
        ],
      }),
    );

    // Injected work outranks even a higher-priority ticket. (It still does not
    // preempt anything already in flight — that is the orchestrator's call.)
    assert.deepEqual(order(graph), ['HOTFIX', 'ROUTINE']);
  });

  it('leaves milestone sequencing to the gate rather than the ranking', () => {
    // A later milestone's tickets cannot reach the frontier at all while an
    // earlier one is unreviewed — they are blocked, not merely outranked. So a
    // ticket in m2 stays out of the frontier even at the highest priority.
    const graph = derive(
      snapshot({
        milestones: [M1, M2],
        nodes: [
          node('LATE', 'available', { milestone: 'm2', priority: 1 }),
          node('EARLY', 'available', { milestone: 'm1', priority: 4 }),
        ],
      }),
    );

    assert.deepEqual(order(graph), ['EARLY']);
    assert.deepEqual(
      graph.blocked.map((entry) => entry.node.id),
      ['LATE'],
    );
  });

  it('ranks purely on urgency once the gate is open', () => {
    // m1 is finished and reviewed, so m2 is startable. From here the milestone
    // a ticket belongs to carries no weight — priority decides.
    const graph = derive(
      snapshot({
        milestones: [M1, M2],
        reviews: [
          {
            milestone: 'm1',
            fingerprint: fingerprintMembers(['DONE']),
            recordedAt: '2026-07-11T00:00:00.000Z',
          },
        ],
        nodes: [
          node('DONE', 'verified', { milestone: 'm1' }),
          node('LOOSE', 'available', { priority: 4 }),
          node('URGENT', 'available', { milestone: 'm2', priority: 1 }),
        ],
      }),
    );

    assert.deepEqual(order(graph), ['URGENT', 'LOOSE']);
  });

  it('prefers the more urgent ticket within a milestone', () => {
    const graph = derive(
      snapshot({
        milestones: [M1],
        nodes: [
          node('LOW', 'available', { milestone: 'm1', priority: 4 }),
          node('URGENT', 'available', { milestone: 'm1', priority: 1 }),
          node('NONE', 'available', { milestone: 'm1' }), // no priority: last
        ],
      }),
    );

    assert.deepEqual(order(graph), ['URGENT', 'LOW', 'NONE']);
  });

  it('breaks a priority tie by how much downstream work the ticket unblocks', () => {
    // Both are ready and equally urgent, but finishing KEYSTONE releases two
    // more tickets while LEAF releases none. Working the critical path first is
    // what keeps the graph opening up.
    const graph = derive(
      snapshot({
        nodes: [
          node('LEAF', 'available', { priority: 2 }),
          node('KEYSTONE', 'available', { priority: 2 }),
          node('X', 'backlog'),
          node('Y', 'backlog'),
        ],
        edges: [edge('KEYSTONE > X'), edge('X > Y')],
      }),
    );

    assert.deepEqual(order(graph), ['KEYSTONE', 'LEAF']);
  });

  it('is deterministic when everything ties', () => {
    const graph = derive(
      snapshot({
        nodes: [
          node('B', 'available'),
          node('C', 'available'),
          node('A', 'available'),
        ],
      }),
    );

    assert.deepEqual(order(graph), ['A', 'B', 'C']);
  });
});
