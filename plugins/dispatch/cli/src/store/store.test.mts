import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { fingerprintMembers } from '../graph/milestones.mts';
import type { GraphNode } from '../graph/types.mts';
import { GraphStore, type GraphDelta, type IngestNode } from './store.mts';

function ingestNode(
  id: string,
  overrides: Partial<IngestNode> = {},
): IngestNode {
  const base: GraphNode = {
    id,
    project: 'p1',
    url: `https://tracker.example/${id}`,
    title: id,
    role: 'available',
    milestone: null,
    targetKind: 'pr',
    humanInteractive: false,
    injected: false,
    priority: null,
    branchHint: null,
    labels: [],
    updatedAt: null,
  };
  return { ...base, ...overrides };
}

function delta(overrides: Partial<GraphDelta> = {}): GraphDelta {
  return { projects: [], milestones: [], nodes: [], cursors: {}, ...overrides };
}

/** One milestone holding the given tickets. */
function milestoneOne(nodes: IngestNode[]): GraphDelta {
  return delta({
    milestones: [{ id: 'm1', project: 'p1', name: 'M1', sortOrder: 1 }],
    nodes: nodes.map((node) => ({ ...node, milestone: 'm1' })),
  });
}

async function open(): Promise<GraphStore> {
  return GraphStore.open(':memory:');
}

describe('delta merge', () => {
  it('keeps an edge that two nodes in the same fetch both declare', () => {
    // A says it blocks B; B says it is blocked by A. Both rewrite their own
    // edge set. If the deletes and inserts interleaved per node, A's delete
    // would wipe the edge B had just inserted and the dependency would vanish.
    return withStore(async (store) => {
      await store.applyDelta(
        delta({
          nodes: [
            ingestNode('A', { blocks: ['B'], blockedBy: [] }),
            ingestNode('B', { blockedBy: ['A'], blocks: [] }),
          ],
        }),
      );

      const snapshot = await store.snapshot();
      assert.deepEqual(snapshot.edges, [{ blocker: 'A', blocked: 'B' }]);
    });
  });

  it('replaces the edges a node declares, in that direction only', () => {
    return withStore(async (store) => {
      await store.applyDelta(
        delta({
          nodes: [ingestNode('C', { blockedBy: ['A'], blocks: ['Z'] })],
        }),
      );

      // A later fetch says C is now blocked by B instead of A, and says nothing
      // about what C blocks. The incoming edge is replaced; the outgoing one is
      // left alone.
      await store.applyDelta(
        delta({ nodes: [ingestNode('C', { blockedBy: ['B'] })] }),
      );

      const snapshot = await store.snapshot();
      assert.deepEqual(snapshot.edges, [
        { blocker: 'B', blocked: 'C' },
        { blocker: 'C', blocked: 'Z' },
      ]);
    });
  });

  it('clears a dependency that the tracker dropped', () => {
    return withStore(async (store) => {
      await store.applyDelta(
        delta({ nodes: [ingestNode('B', { blockedBy: ['A'] })] }),
      );
      await store.applyDelta(
        delta({ nodes: [ingestNode('B', { blockedBy: [] })] }),
      );

      const snapshot = await store.snapshot();
      assert.deepEqual(snapshot.edges, []);
    });
  });

  it('updates a ticket in place rather than duplicating it', () => {
    return withStore(async (store) => {
      await store.applyDelta(
        delta({ nodes: [ingestNode('A', { role: 'available' })] }),
      );
      await store.applyDelta(
        delta({
          nodes: [ingestNode('A', { role: 'in-progress', title: 'renamed' })],
        }),
      );

      const snapshot = await store.snapshot();
      assert.equal(snapshot.nodes.length, 1);
      assert.equal(snapshot.nodes[0]?.role, 'in-progress');
      assert.equal(snapshot.nodes[0]?.title, 'renamed');
    });
  });

  it('removes a deleted ticket and the edges that referenced it', () => {
    return withStore(async (store) => {
      await store.applyDelta(
        delta({
          nodes: [ingestNode('A', { blocks: ['B'] }), ingestNode('B')],
        }),
      );

      await store.applyDelta(
        delta({ nodes: [{ ...ingestNode('A'), deleted: true }] }),
      );

      const snapshot = await store.snapshot();
      assert.deepEqual(
        snapshot.nodes.map((n) => n.id),
        ['B'],
      );
      // A dangling edge to a deleted ticket would hold B blocked forever.
      assert.deepEqual(snapshot.edges, []);
    });
  });

  it('round-trips the fields the graph reasons over', () => {
    return withStore(async (store) => {
      await store.applyDelta(
        delta({
          nodes: [
            ingestNode('A', {
              role: 'awaiting-external',
              milestone: 'm1',
              targetKind: 'verification',
              humanInteractive: true,
              injected: true,
              priority: 2,
              branchHint: 'clc-1-thing',
              labels: ['human-led', 'infra'],
              updatedAt: '2026-07-11T00:00:00Z',
            }),
          ],
        }),
      );

      const [node] = (await store.snapshot()).nodes;
      assert.equal(node?.role, 'awaiting-external');
      assert.equal(node?.milestone, 'm1');
      assert.equal(node?.targetKind, 'verification');
      assert.equal(node?.humanInteractive, true);
      assert.equal(node?.injected, true);
      assert.equal(node?.priority, 2);
      assert.equal(node?.branchHint, 'clc-1-thing');
      assert.deepEqual(node?.labels, ['human-led', 'infra']);
      assert.equal(node?.updatedAt, '2026-07-11T00:00:00Z');
    });
  });
});

describe('full sync', () => {
  it('drops tickets the tracker no longer returns', () => {
    return withStore(async (store) => {
      await store.applyDelta(
        delta({ nodes: [ingestNode('A'), ingestNode('STALE')] }),
      );

      await store.applyDelta(delta({ nodes: [ingestNode('A')] }), {
        full: true,
      });

      const snapshot = await store.snapshot();
      assert.deepEqual(
        snapshot.nodes.map((n) => n.id),
        ['A'],
      );
    });
  });

  it("preserves the orchestrator's own bookkeeping", () => {
    // A full sync rebuilds the producer's view of the tracker. Exclusions and
    // recorded reviews are the orchestrator's, not the tracker's — wiping them
    // would re-dispatch in-flight work and re-run finished reviews.
    return withStore(async (store) => {
      const done = milestoneOne([ingestNode('A', { role: 'verified' })]);
      await store.applyDelta(done);
      await store.addExclusion('A', 'in-flight');
      await store.recordReview(
        'm1',
        fingerprintMembers(['A']),
        '2026-07-11T00:00:00Z',
      );

      // The same milestone, still complete: the review still describes it.
      await store.applyDelta(done, { full: true });

      const snapshot = await store.snapshot();
      assert.deepEqual(snapshot.exclusions, [{ id: 'A', kind: 'in-flight' }]);
      assert.equal(snapshot.reviews.length, 1);
    });
  });
});

describe('review records', () => {
  it('drops a review when the milestone regains open work', () => {
    // A review that files follow-up tickets into its own milestone ends the
    // episode it reviewed. The record must not survive to satisfy the gate when
    // the milestone completes again — a fresh review is required.
    return withStore(async (store) => {
      await store.applyDelta(
        milestoneOne([ingestNode('A', { role: 'verified' })]),
      );
      await store.recordReview(
        'm1',
        fingerprintMembers(['A']),
        '2026-07-11T00:00:00Z',
      );
      assert.equal((await store.snapshot()).reviews.length, 1);

      // The review files a follow-up into the milestone it just reviewed.
      const result = await store.applyDelta(
        milestoneOne([ingestNode('B', { role: 'available' })]),
      );

      assert.equal(result.reviewsDropped, 1);
      assert.deepEqual((await store.snapshot()).reviews, []);
    });
  });

  it('drops a review when a finished member is reopened', () => {
    // Reopening and re-verifying a member leaves the member-id set identical, so
    // a fingerprint over ids alone would still match and the stale review would
    // silently reopen the gate. The episode ended; the record must go with it.
    return withStore(async (store) => {
      await store.applyDelta(
        milestoneOne([ingestNode('A', { role: 'verified' })]),
      );
      await store.recordReview(
        'm1',
        fingerprintMembers(['A']),
        '2026-07-11T00:00:00Z',
      );

      await store.applyDelta(
        milestoneOne([ingestNode('A', { role: 'in-progress' })]),
      );
      assert.deepEqual((await store.snapshot()).reviews, []);

      // Re-verified: same member set as the reviewed episode, but no record.
      await store.applyDelta(
        milestoneOne([ingestNode('A', { role: 'verified' })]),
      );
      assert.deepEqual((await store.snapshot()).reviews, []);
    });
  });
});

describe('cursors', () => {
  it('reports no cursor before the first sync', () => {
    // An absent cursor is the first-run signal: the caller does a full sync.
    return withStore(async (store) => {
      assert.equal(await store.getCursor('linear'), null);
    });
  });

  it('stores the cursor with the batch it came from', () => {
    return withStore(async (store) => {
      await store.applyDelta(
        delta({ nodes: [ingestNode('A')], cursors: { linear: 'T1' } }),
      );
      assert.equal(await store.getCursor('linear'), 'T1');

      await store.applyDelta(delta({ cursors: { linear: 'T2' } }));
      assert.equal(await store.getCursor('linear'), 'T2');
    });
  });
});

describe('reviews', () => {
  it('keeps only the newest review per milestone', () => {
    // Only the current episode matters. Keeping the old record risks an earlier
    // member set recurring and reading as already reviewed.
    return withStore(async (store) => {
      await store.recordReview('m1', 'fp-old', '2026-07-01T00:00:00Z');
      await store.recordReview('m1', 'fp-new', '2026-07-11T00:00:00Z');

      const { reviews } = await store.snapshot();
      assert.equal(reviews.length, 1);
      assert.equal(reviews[0]?.fingerprint, 'fp-new');
    });
  });
});

describe('projects', () => {
  it('does not invent a project row for a project it never fetched', () => {
    // The ticket is kept, but no project record is fabricated for it. Inferring
    // the project (and marking it partial) is `derive`'s job, so the inference
    // holds however the snapshot was assembled.
    return withStore(async (store) => {
      await store.applyDelta(
        delta({ nodes: [ingestNode('A', { project: 'ghost' })] }),
      );

      const { projects, nodes } = await store.snapshot();
      assert.deepEqual(projects, []);
      assert.equal(nodes[0]?.project, 'ghost');
    });
  });
});

async function withStore(
  body: (store: GraphStore) => Promise<void>,
): Promise<void> {
  const store = await open();
  try {
    await body(store);
  } finally {
    await store.close();
  }
}
