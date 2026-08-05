import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {diffSnapshots} from './diff.mts';
import type {Observation} from './diff.mts';
import type {PrSnapshot} from './snapshot.mts';

const BASE: PrSnapshot = {
  head: 'aaaaaaaa',
  state: 'OPEN',
  draft: false,
  merged: false,
  mergeable: 'MERGEABLE',
  mergeState: 'BLOCKED',
  reviewDecision: 'REVIEW_REQUIRED',
  rollup: 'SUCCESS',
  checks: [{name: 'test', conclusion: 'SUCCESS', url: null}],
  reviews: [],
  threads: [],
  comments: [],
  totals: {reviews: 0, threads: 0, comments: 0},
};

function snap(over: Partial<PrSnapshot>): PrSnapshot {
  return {...BASE, ...over};
}

function review(
  over: Partial<PrSnapshot['reviews'][number]> = {}
): PrSnapshot['reviews'][number] {
  return {
    author: 'human',
    state: 'APPROVED',
    submittedAt: '2026-01-01T00:00:00Z',
    mine: false,
    ...over,
  };
}

function comment(
  over: Partial<PrSnapshot['comments'][number]> = {}
): PrSnapshot['comments'][number] {
  return {
    id: 'c1',
    author: 'human',
    createdAt: '2026-01-01T00:00:00Z',
    mine: false,
    ...over,
  };
}

function thread(
  over: Partial<PrSnapshot['threads'][number]> = {}
): PrSnapshot['threads'][number] {
  return {
    id: 't1',
    resolved: false,
    outdated: false,
    lastAuthor: 'human',
    lastAt: '2026-01-01T00:00:00Z',
    mine: false,
    ...over,
  };
}

function kinds(previous: PrSnapshot | null, next: PrSnapshot): string[] {
  return diffSnapshots(previous, next).map((event) => event.kind);
}

function only(previous: PrSnapshot, next: PrSnapshot): Observation {
  const events = diffSnapshots(previous, next);
  assert.equal(events.length, 1);
  const [event] = events;
  assert.ok(event !== undefined);
  return event;
}

describe('diffSnapshots', () => {
  it('reports nothing for the first observation after arming', () => {
    // The wait's own condition is evaluated separately; a baseline has no
    // change to report against.
    assert.deepEqual(kinds(null, BASE), []);
  });

  it('reports nothing when nothing moved', () => {
    assert.deepEqual(kinds(BASE, snap({})), []);
  });

  it('names the failing checks in ci_finished meta', () => {
    const event = only(
      snap({checks: [{name: 'test', conclusion: null, url: null}]}),
      snap({
        checks: [
          {name: 'lint', conclusion: 'FAILURE', url: 'https://ci/lint'},
          {name: 'test', conclusion: 'SUCCESS', url: null},
        ],
      })
    );
    assert.equal(event.kind, 'ci_finished');
    assert.equal(event.meta.rollup, 'failure');
    assert.equal(event.meta.failing, 'lint');
  });

  it('treats an unrecognized terminal conclusion as a failure', () => {
    // A conclusion GitHub adds later must not read as a silent pass.
    const event = only(
      snap({checks: [{name: 'test', conclusion: null, url: null}]}),
      snap({checks: [{name: 'test', conclusion: 'ACTION_REQUIRED', url: null}]})
    );
    assert.equal(event.meta.rollup, 'failure');
  });

  it('reports a rerun that goes straight from failing to green', () => {
    // Both snapshots are settled, so a settled-ness test alone would miss it.
    const failed = snap({
      checks: [{name: 'test', conclusion: 'FAILURE', url: null}],
    });
    const green = snap({
      checks: [{name: 'test', conclusion: 'SUCCESS', url: null}],
    });
    assert.equal(only(failed, green).meta.rollup, 'success');
  });

  it('does not re-report an unchanged failing rollup', () => {
    const failed = snap({
      checks: [{name: 'test', conclusion: 'FAILURE', url: null}],
    });
    assert.deepEqual(kinds(failed, failed), []);
  });

  it('reports a review verdict but never a pending one', () => {
    const pending = snap({
      reviews: [review({state: 'PENDING', submittedAt: null})],
    });
    assert.deepEqual(kinds(BASE, pending), []);
    const event = only(
      pending,
      snap({reviews: [review({state: 'CHANGES_REQUESTED'})]})
    );
    assert.equal(event.kind, 'pr_review');
    assert.equal(event.meta.state, 'changes');
    assert.equal(event.meta.reviewer, 'human');
  });

  it("suppresses a post carrying this agent's marker, whatever account wrote it", () => {
    // Under shared credentials the agent posts as the operator, so the
    // account cannot be the test.
    const mine = snap({
      reviews: [review({author: 'operator', mine: true})],
      comments: [comment({author: 'operator', mine: true})],
      threads: [thread({lastAuthor: 'operator', mine: true})],
      totals: {reviews: 1, threads: 1, comments: 1},
    });
    assert.deepEqual(kinds(BASE, mine), []);
  });

  it("reports the operator's own unmarked review on a shared account", () => {
    // Same login as the agent, but no marker: a human wrote it, and it is
    // the one signal a waiting worker most needs.
    const theirs = snap({
      reviews: [review({author: 'operator'})],
      totals: {reviews: 1, threads: 0, comments: 0},
    });
    assert.deepEqual(kinds(BASE, theirs), ['pr_review']);
  });

  it("reports a reviewer's reply on a thread the agent last touched", () => {
    const mine = snap({threads: [thread({mine: true, lastAuthor: 'agent'})]});
    const theirs = snap({threads: [thread({lastAt: '2026-01-02T00:00:00Z'})]});
    assert.equal(only(mine, theirs).kind, 'pr_comment');
  });

  it('ignores a thread once it is resolved', () => {
    const open = snap({threads: [thread()]});
    const resolved = snap({threads: [thread({resolved: true})]});
    assert.deepEqual(kinds(open, resolved), []);
  });

  it('does not treat an old comment re-entering the window as new', () => {
    // The previous window was truncated, so "absent from it" is not "new".
    const truncated = snap({
      comments: [comment({id: 'c9', createdAt: '2026-02-01T00:00:00Z'})],
      totals: {reviews: 0, threads: 0, comments: 30},
    });
    const shifted = snap({
      comments: [
        comment({id: 'c1', createdAt: '2026-01-01T00:00:00Z'}),
        comment({id: 'c9', createdAt: '2026-02-01T00:00:00Z'}),
      ],
      totals: {reviews: 0, threads: 0, comments: 30},
    });
    assert.deepEqual(kinds(truncated, shifted), []);
  });

  it('still reports a genuinely newer comment past the window', () => {
    const truncated = snap({
      comments: [comment({id: 'c9', createdAt: '2026-02-01T00:00:00Z'})],
      totals: {reviews: 0, threads: 0, comments: 30},
    });
    const newer = snap({
      comments: [
        comment({id: 'c9', createdAt: '2026-02-01T00:00:00Z'}),
        comment({id: 'c10', createdAt: '2026-03-01T00:00:00Z'}),
      ],
      totals: {reviews: 0, threads: 0, comments: 31},
    });
    assert.deepEqual(kinds(truncated, newer), ['pr_comment']);
  });

  it('coalesces two comments in one tick into one event', () => {
    // Meta is single-valued, so one event cannot name two threads.
    const event = only(
      BASE,
      snap({
        comments: [comment({id: 'c1'}), comment({id: 'c2'})],
        totals: {reviews: 0, threads: 0, comments: 2},
      })
    );
    assert.equal(event.kind, 'pr_comment');
    assert.equal(event.meta.more, '1');
  });

  it('reports leaving draft as a state change', () => {
    const event = only(snap({draft: true}), snap({draft: false}));
    assert.equal(event.kind, 'pr_state_change');
    assert.equal(event.meta.state, 'ready');
  });

  it('reports a head move', () => {
    // Checks unsettled, as they are right after a push: the rollup belongs
    // to the new head and has nothing to say yet.
    const pending = snap({
      checks: [{name: 'test', conclusion: null, url: null}],
    });
    assert.equal(
      only(pending, {...pending, head: 'bbbbbbbb'}).kind,
      'pr_head_changed'
    );
  });

  it('re-reports CI on a new head even when the failing set is unchanged', () => {
    // Without comparing heads, a rerun on a new commit that fails the same
    // way looks identical to the old result and would never be reported.
    const failed = snap({
      checks: [{name: 'test', conclusion: 'FAILURE', url: null}],
    });
    assert.deepEqual(
      diffSnapshots(failed, {...failed, head: 'bbbbbbbb'}).map((e) => e.kind),
      ['pr_head_changed', 'ci_finished']
    );
  });

  it('reports a conflict once, not every poll', () => {
    const dirty = snap({mergeState: 'DIRTY'});
    assert.deepEqual(kinds(BASE, dirty), ['pr_conflicted']);
    assert.deepEqual(kinds(dirty, dirty), []);
  });

  it('reports a merge alone, suppressing what arrived with it', () => {
    assert.deepEqual(
      kinds(
        BASE,
        snap({
          merged: true,
          state: 'MERGED',
          head: 'bbbbbbbb',
          comments: [comment()],
        })
      ),
      ['pr_state_change']
    );
  });

  it('reports a close without judging whether it shipped', () => {
    // A squash or rebase lands the content without setting `merged`;
    // resolving that is `pr-status`'s job, not the diff's.
    assert.equal(only(BASE, snap({state: 'CLOSED'})).meta.state, 'closed');
  });
});
