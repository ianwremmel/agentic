import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {derive} from './derive.mts';
import {edges, frontier} from './queries.mts';
import {node, seededStore} from './test-support.mts';

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse('2026-07-14T12:00:00.000Z');
const OPTS = {nowMs: NOW, staleAfterMs: HOUR};

describe('tasks and edges', () => {
  it('upserts a task and reads it back', async () => {
    const store = await seededStore();
    await store.upsertTask(node('A', {role: 'in-progress', title: 'Thing'}));
    await store.upsertTask(node('A', {role: 'in-review', title: 'Renamed'}));

    const {nodes} = derive(store.database);
    const stored = nodes[0];
    assert.ok(stored);
    assert.equal(nodes.length, 1);
    assert.equal(stored.node.role, 'in-review');
    assert.equal(stored.node.title, 'Renamed');
    await store.close();
  });

  it('rejects an --updated-at that is not an RFC 3339 instant', async () => {
    const store = await seededStore();
    await assert.rejects(
      () => store.upsertTask(node('A', {updatedAt: 'yesterday-ish'})),
      /--updated-at is not a timestamp/
    );
    // Date.parse would happily read this US-local format; the store must not.
    await assert.rejects(
      () => store.upsertTask(node('A', {updatedAt: '07/15/2026'})),
      /--updated-at is not a timestamp/
    );
    await store.close();
  });

  it('removes a milestone that tasks still name, surfacing them as an anomaly', async () => {
    const store = await seededStore({
      milestones: [
        {id: 'm1', project: 'P', name: 'M1'},
        {id: 'm2', project: 'P', name: 'M2'},
      ],
      nodes: [node('A', {milestone: 'm1'})],
      edges: [['m1', 'm2']],
    });

    assert.equal(await store.removeMilestone('m1'), true);

    const graph = derive(store.database);
    assert.deepEqual(
      graph.milestones.map((entry) => entry.id),
      ['m2']
    );
    assert.deepEqual(graph.edges, []);
    // A's membership is the tracker's fact, not the delete's: it survives and
    // reads as an unknown milestone until a re-sync clears or re-declares it.
    assert.equal(graph.anomalies[0]?.kind, 'unknown-milestone');
    await store.close();
  });

  it('removes a task with its edges and claim', async () => {
    const store = await seededStore({
      nodes: [node('A'), node('B')],
      edges: [['A', 'B']],
    });
    assert.equal((await store.claim('A', 'agent-a', OPTS)).outcome, 'claimed');

    assert.equal(await store.removeTask('A'), true);
    const graph = derive(store.database, OPTS);
    assert.deepEqual(
      graph.nodes.map((entry) => entry.node.id),
      ['B']
    );
    assert.deepEqual(graph.edges, []);
    assert.equal(graph.nodes[0]?.claim, null);
    await store.close();
  });

  it('replaces one direction of a node with edge set, leaving the other alone', async () => {
    const store = await seededStore();
    await store.setEdges('B', 'blockers', ['A']);
    await store.setEdges('B', 'blocks', ['C']);
    // Re-declare B's blockers as exactly {A2}; B->C must survive.
    await store.setEdges('B', 'blockers', ['A2']);

    assert.deepEqual(edges(store.database), [
      {blocker: 'A2', blocked: 'B'},
      {blocker: 'B', blocked: 'C'},
    ]);
    await store.close();
  });

  it('clears a direction when edge set is given an empty list', async () => {
    const store = await seededStore();
    await store.setEdges('B', 'blockers', ['A']);
    await store.setEdges('B', 'blockers', []);
    assert.deepEqual(edges(store.database), []);
    await store.close();
  });

  it('refuses an edge that would close a cycle, leaving the graph unchanged', async () => {
    const store = await seededStore();
    await store.addEdge('A', 'B');
    await store.addEdge('B', 'C');
    await assert.rejects(() => store.addEdge('C', 'A'), /dependency cycle/);

    // Rolled back — the offending edge is not present.
    assert.deepEqual(edges(store.database), [
      {blocker: 'A', blocked: 'B'},
      {blocker: 'B', blocked: 'C'},
    ]);
    await store.close();
  });

  it('refuses an edge set that would close a cycle', async () => {
    const store = await seededStore();
    await store.addEdge('A', 'B');
    await store.addEdge('B', 'C');
    // C is reachable from A, so making C a blocker of A closes A->B->C->A.
    await assert.rejects(
      () => store.setEdges('A', 'blockers', ['C']),
      /dependency cycle/
    );
    await store.close();
  });

  it('refuses a self-edge', async () => {
    const store = await seededStore();
    await assert.rejects(
      () => store.setEdges('A', 'blockers', ['A']),
      /cannot block itself/
    );
    await store.close();
  });

  it('refuses an id that already names the other kind', async () => {
    // Tasks and milestones share the node id space, so a collision would make
    // an edge ambiguous and a delete wipe the wrong kind's edges.
    const store = await seededStore();
    await store.upsertMilestone({id: 'X', project: 'P', name: 'X'});
    await assert.rejects(
      () => store.upsertTask(node('X')),
      /already a milestone/
    );

    await store.upsertTask(node('Y'));
    await assert.rejects(
      () => store.upsertMilestone({id: 'Y', project: 'P', name: 'Y'}),
      /already a task/
    );
    await store.close();
  });

  it('refuses an edge joining a task and a milestone', async () => {
    const store = await seededStore({
      milestones: [{id: 'm1', project: 'P', name: 'M1'}],
      nodes: [node('A')],
    });
    await assert.rejects(
      () => store.addEdge('m1', 'A'),
      /cannot join a task and a milestone/
    );
    await store.close();
  });

  it('promotes a placeholder named by an edge when its task arrives', async () => {
    const store = await seededStore({nodes: [node('B')]});
    await store.addEdge('LATER', 'B');
    await store.upsertTask(node('LATER'));

    const graph = derive(store.database);
    assert.deepEqual(
      graph.anomalies.filter((a) => a.kind === 'dangling-edge'),
      []
    );
    await store.close();
  });

  it('refuses a promotion that would create a task↔milestone edge', async () => {
    const store = await seededStore({
      milestones: [{id: 'm1', project: 'P', name: 'M1'}],
    });
    // A sequencing edge to a not-yet-declared id; that id then shows up as a
    // task, which would silently turn the edge into a task↔milestone edge.
    await store.addEdge('m1', 'LATER');
    await assert.rejects(
      () => store.upsertTask(node('LATER')),
      /cannot become a task/
    );
    await store.close();
  });

  it('refuses to make a task out of an id tasks use as their milestone', async () => {
    const store = await seededStore({
      nodes: [node('A', {milestone: 'M-LATER'})],
    });
    await assert.rejects(
      () => store.upsertTask(node('M-LATER')),
      /names it as its milestone/
    );
    await store.close();
  });

  it('refuses --milestone pointed at a task', async () => {
    const store = await seededStore({nodes: [node('A')]});
    await assert.rejects(
      () => store.upsertTask(node('B', {milestone: 'A'})),
      /a task cannot be another task's milestone/
    );
    await store.close();
  });
});

describe('reset', () => {
  it('wipes the graph but keeps claims, reviews, and cursors', async () => {
    const store = await seededStore({
      milestones: [{id: 'm1', project: 'P', name: 'M1'}],
      nodes: [node('A'), node('V', {role: 'verified', milestone: 'm1'})],
    });
    assert.equal((await store.claim('A', 'agent-a', OPTS)).outcome, 'claimed');
    await store.recordReview('m1', NOW, {});
    await store.setCursor('linear', 'token');

    await store.reset();

    const graph = derive(store.database, OPTS);
    assert.deepEqual(graph.nodes, []);
    assert.deepEqual(graph.milestones, []);
    assert.equal(await store.getCursor('linear'), 'token');

    // The re-sync brings the same graph back: the claim still holds its task
    // off the frontier, and the recorded review still covers the milestone.
    await store.upsertProject({id: 'P', name: 'Project'});
    await store.upsertMilestone({id: 'm1', project: 'P', name: 'M1'});
    await store.upsertTask(node('A'));
    await store.upsertTask(node('V', {role: 'verified', milestone: 'm1'}));

    const resynced = derive(store.database, OPTS);
    assert.equal(
      resynced.nodes.find((entry) => entry.node.id === 'A')?.claim?.agent,
      'agent-a'
    );
    assert.equal(resynced.milestones[0]?.reviewRecorded, true);
    await store.close();
  });
});

describe('claims', () => {
  it('claims a free, available task', async () => {
    const store = await seededStore({nodes: [node('A')]});
    assert.equal((await store.claim('A', 'agent-a', OPTS)).outcome, 'claimed');
    await store.close();
  });

  it('refuses to claim a task that is not available, naming its state', async () => {
    const store = await seededStore({
      nodes: [node('A'), node('B')],
      edges: [['A', 'B']],
    });
    const result = await store.claim('B', 'agent-a', OPTS);
    assert.equal(result.outcome, 'not-available');
    assert.equal(result.classification, 'blocked');
    await store.close();
  });

  it('refuses to claim a task the graph does not hold', async () => {
    const store = await seededStore();
    assert.equal(
      (await store.claim('A', 'agent-a', OPTS)).outcome,
      'unknown-task'
    );
    await store.close();
  });

  it('a re-claim by the holder just refreshes the heartbeat', async () => {
    const store = await seededStore({nodes: [node('A')]});
    await store.claim('A', 'agent-a', OPTS);
    const result = await store.claim('A', 'agent-a', {
      nowMs: NOW + 5 * 60 * 1000,
      staleAfterMs: HOUR,
    });
    assert.equal(result.outcome, 'refreshed');
    await store.close();
  });

  it('refuses a live claim held by another agent', async () => {
    const store = await seededStore({nodes: [node('A')]});
    await store.claim('A', 'agent-a', OPTS);
    const result = await store.claim('A', 'agent-b', {
      nowMs: NOW + 60_000,
      staleAfterMs: HOUR,
    });
    assert.equal(result.outcome, 'held');
    assert.equal(result.heldBy, 'agent-a');
    await store.close();
  });

  it('reclaims a stale claim for a new agent, even off the frontier', async () => {
    const store = await seededStore({nodes: [node('A')]});
    await store.claim('A', 'agent-a', OPTS);
    // Two hours later agent-a's claim is stale — and A classifies as
    // in-flight under it, which must not stop the takeover.
    const result = await store.claim('A', 'agent-b', {
      nowMs: NOW + 2 * HOUR,
      staleAfterMs: HOUR,
    });
    assert.equal(result.outcome, 'reclaimed');
    await store.close();
  });

  it('claimNext takes the top candidate no live agent holds', async () => {
    const store = await seededStore({
      nodes: [node('A', {priority: 1}), node('B', {priority: 2}), node('C')],
    });
    await store.claim('A', 'agent-a', OPTS); // A held live
    const taken = await store.claimNext('agent-b', {
      nowMs: NOW + 60_000,
      staleAfterMs: HOUR,
    });
    assert.equal(taken?.entry.node.id, 'B');
    // B is now claimed too, so the frontier holds only C.
    assert.deepEqual(
      frontier(store.database, {
        nowMs: NOW + 60_000,
        staleAfterMs: HOUR,
      }).map((entry) => entry.node.id),
      ['C']
    );
    await store.close();
  });

  it('heartbeat refreshes only the holder', async () => {
    const store = await seededStore({nodes: [node('A')]});
    await store.claim('A', 'agent-a', OPTS);
    assert.equal(await store.heartbeat('A', 'agent-b', NOW + 60_000), false);
    assert.equal(await store.heartbeat('A', 'agent-a', NOW + 60_000), true);
    await store.close();
  });

  it('release is idempotent and refuses another agent', async () => {
    const store = await seededStore({nodes: [node('A')]});
    await store.claim('A', 'agent-a', OPTS);
    assert.equal(await store.release('A', 'agent-b'), 'not-yours');
    assert.equal(await store.release('A', 'agent-a'), 'released');
    assert.equal(await store.release('A', 'agent-a'), 'absent');
    await store.close();
  });
});

describe('reviews', () => {
  it('refuses to record a review of a milestone with open work', async () => {
    const store = await seededStore({
      milestones: [{id: 'm1', project: 'P', name: 'M1'}],
      nodes: [node('A', {milestone: 'm1'})],
    });
    await assert.rejects(
      () => store.recordReview('m1', NOW, {}),
      /not ready for review/
    );
    await store.close();
  });

  it('refuses to record a review of a milestone the graph does not hold', async () => {
    const store = await seededStore();
    await assert.rejects(
      () => store.recordReview('m1', NOW, {}),
      /no milestone "m1"/
    );
    await store.close();
  });
});

describe('projects', () => {
  it('undeclares a project on rm, leaving its tasks alone', async () => {
    const store = await seededStore({nodes: [node('A', {role: 'verified'})]});

    // Declared and finished: terminal.
    assert.equal(derive(store.database).counts[0]?.terminal, true);

    assert.equal(await store.removeProject('P'), true);
    assert.equal(await store.removeProject('P'), false);

    const graph = derive(store.database);
    // Still surfaced (a task names it) but partial now, so never terminal.
    const counts = graph.counts[0];
    assert.ok(counts);
    assert.equal(counts.partial, true);
    assert.equal(counts.terminal, false);
    assert.equal(graph.nodes.length, 1);
    await store.close();
  });
});

describe('cursors', () => {
  it('stores, reads, and clears a cursor', async () => {
    const store = await seededStore();
    await store.setCursor('linear', '2026-07-11T00:00:00.000Z');
    assert.equal(await store.getCursor('linear'), '2026-07-11T00:00:00.000Z');
    assert.equal(await store.clearCursor('linear'), true);
    assert.equal(await store.getCursor('linear'), null);
    await store.close();
  });
});

describe('agent footprint', () => {
  it('claim and heartbeat record checkout facts without erasing them', async () => {
    const store = await seededStore({nodes: [node('A')]});
    await store.claim('A', 'agent-a', OPTS, {branch: 'feat/a'});
    // A later heartbeat adds the worktree; the branch it does not mention stays.
    await store.heartbeat('A', 'agent-a', NOW + 1000, {worktree: '/wt/a'});

    const row = store.database.get(
      'SELECT worktree, branch FROM claim WHERE agent = ?',
      ['agent-a']
    );
    assert.deepEqual({...row}, {worktree: '/wt/a', branch: 'feat/a'});
    await store.close();
  });

  it('heartbeatAgent refreshes every claim and the slot in one write', async () => {
    const store = await seededStore({nodes: [node('A')]});
    await store.claim('A', 'agent-a', OPTS);
    await store.acquireSlot('agent-a', 3, NOW, HOUR);

    const later = NOW + 50 * 60 * 1000; // would be near-stale without a beat
    const touched = await store.heartbeatAgent('agent-a', later);
    assert.deepEqual(touched, {claims: 1, slot: true});

    // Both survived past the original staleness horizon.
    const claim = await store.claim('A', 'agent-b', {
      nowMs: NOW + HOUR + 1000,
      staleAfterMs: HOUR,
    });
    assert.equal(claim.outcome, 'held');
    const slots = await store.slots(NOW + HOUR + 1000, HOUR);
    assert.deepEqual(slots, [{agent: 'agent-a', live: true}]);
    await store.close();
  });

  it('heartbeatAgent reports an empty footprint instead of inventing one', async () => {
    const store = await seededStore();
    assert.deepEqual(await store.heartbeatAgent('ghost', NOW), {
      claims: 0,
      slot: false,
    });
    await store.close();
  });

  it('setOutcome refuses a reporter whose claim was reclaimed', async () => {
    const store = await seededStore({nodes: [node('A')]});
    await store.claim('A', 'agent-a', OPTS);
    // agent-a goes stale; agent-b takes the item over.
    await store.claim('A', 'agent-b', {
      nowMs: NOW + 2 * HOUR,
      staleAfterMs: HOUR,
    });

    await assert.rejects(
      store.setOutcome(
        'A',
        'agent-a',
        {outcome: 'delivered', retryable: null, detail: null},
        NOW + 2 * HOUR
      ),
      /claimed by another agent/u
    );
    await store.close();
  });

  it('setOutcome releases the reporter slot along with its claim', async () => {
    const store = await seededStore({nodes: [node('A')]});
    await store.claim('A', 'agent-a', OPTS);
    await store.acquireSlot('agent-a', 3, NOW, HOUR);

    await store.setOutcome(
      'A',
      'agent-a',
      {outcome: 'delivered', retryable: null, detail: null},
      NOW + 1000
    );

    assert.deepEqual(await store.slots(NOW + 1000, HOUR), []);
    await store.close();
  });
});
