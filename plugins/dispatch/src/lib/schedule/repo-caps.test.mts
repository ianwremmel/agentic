import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {ticket as baseTicket} from '../command/test-support.mts';
import {Database} from '../db/database.mts';
import type {RepoCapPolicy} from '../model/index.mts';
import {
  PolicyStore,
  PrStore,
  ProjectStore,
  SessionStore,
  TicketStore,
  WatchStore,
} from '../stores/index.mts';
import type {PrSnapshot} from '../watch/snapshot.mts';
import {Scheduler} from './scheduler.mts';

const NOW = '2026-08-03T12:00:00.000Z';
const LATER = '2026-08-03T12:01:00.000Z';
const EXPIRES = '2026-08-03T13:00:00.000Z';

function caps(over: Partial<RepoCapPolicy>): RepoCapPolicy {
  return {
    openPrs: 9,
    inFlightBuilds: 9,
    openPrsByRepo: {},
    inFlightBuildsByRepo: {},
    ...over,
  };
}

async function fresh(
  policy: RepoCapPolicy,
  maxParallel = 5
): Promise<{db: Database; scheduler: Scheduler}> {
  const db = await Database.open(':memory:');
  await new ProjectStore(db).upsertProject({
    id: 'P',
    name: 'P',
    source: 'linear',
  });
  const sessions = new SessionStore(db);
  await sessions.register({
    id: 'S1',
    startedAt: NOW,
    heartbeatAt: NOW,
    claudeSessionId: 'claude-1',
  });
  await sessions.ack('S1', 'claude-1', NOW);
  await new PolicyStore(db).setRepoCaps(policy);
  return {db, scheduler: new Scheduler(db, {session: 'S1', maxParallel})};
}

async function addPr(
  db: Database,
  id: string,
  repo: string,
  prNumber: number | null
): Promise<void> {
  await new PrStore(db).upsertPr({
    id,
    ticket: null,
    origin: 'prompt',
    repo,
    prNumber,
    url: null,
    branch: null,
    title: id,
    injected: false,
    priority: null,
    updatedAt: null,
  });
}

function snapshot(state: string, rollup: string): PrSnapshot {
  return {
    head: 'aaaaaaaa',
    state,
    draft: false,
    merged: state === 'MERGED',
    mergeable: 'MERGEABLE',
    mergeState: 'CLEAN',
    reviewDecision: null,
    rollup,
    checks: [],
    reviews: [],
    threads: [],
    comments: [],
    totals: {reviews: 0, threads: 0, comments: 0},
  };
}

/**
 * Record what the poll last saw for a PR. A watch still `watching` is a wait
 * the server owns, so its item never queues; firing it is what hands the item
 * back as a `resume`.
 */
async function observed(
  db: Database,
  node: string,
  snap: PrSnapshot,
  opts: {fired?: boolean} = {}
): Promise<void> {
  const watches = new WatchStore(db);
  await watches.set({
    node,
    intervalSeconds: 60,
    at: NOW,
    expiresAt: EXPIRES,
    snapshot: snap,
    session: null,
  });
  if (opts.fired === true) await watches.fire(node, NOW, NOW);
}

async function dispatchedPrs(
  scheduler: Scheduler,
  now: string
): Promise<string[]> {
  const {orders} = await scheduler.tick(now);
  return orders
    .filter((order) => order.kind === 'dispatch_pr')
    .map((order) => String(order.meta.pr));
}

describe('per-repo admission caps', () => {
  it('refuses a PR item that would open a new PR at the open-PR cap, and resumes one whose PR exists', async () => {
    const {db, scheduler} = await fresh(caps({openPrs: 1}));
    await addPr(db, 'o/r#7', 'o/r', 7);
    await observed(db, 'o/r#7', snapshot('OPEN', 'SUCCESS'), {fired: true});
    await addPr(db, 'o/r#new', 'o/r', null);

    // The open PR is the whole cap, so the unopened item waits — but working
    // the PR that already exists adds nothing to the pool, and refusing it
    // would leave nothing able to finish and free the slot.
    assert.deepEqual(await dispatchedPrs(scheduler, NOW), ['o/r#7']);
    await db.close();
  });

  it('refuses both a new and a resumed PR item at the in-flight-build cap', async () => {
    const {db, scheduler} = await fresh(caps({inFlightBuilds: 1}));
    await addPr(db, 'o/r#7', 'o/r', 7);
    await observed(db, 'o/r#7', snapshot('OPEN', 'PENDING'));
    await addPr(db, 'o/r#8', 'o/r', 8);
    await observed(db, 'o/r#8', snapshot('OPEN', 'SUCCESS'), {fired: true});
    await addPr(db, 'o/r#new', 'o/r', null);

    assert.deepEqual(await dispatchedPrs(scheduler, NOW), []);
    await db.close();
  });

  it('holds only the repo at its cap, and keeps filling for the others', async () => {
    const {db, scheduler} = await fresh(caps({openPrsByRepo: {'a/x': 1}}));
    await addPr(db, 'a/x#1', 'a/x', 1);
    await observed(db, 'a/x#1', snapshot('OPEN', 'SUCCESS'));
    await addPr(db, 'a/x#new', 'a/x', null);
    await addPr(db, 'b/y#new', 'b/y', null);

    // `a/x#new` sorts first in the queue: a refusal must skip it, not end the
    // pass, or the entry behind it never gets its turn.
    assert.deepEqual(await dispatchedPrs(scheduler, NOW), ['b/y#new']);
    await db.close();
  });

  it('releases each cap on its own signal — the PR closing, and the build finishing', async () => {
    const {db, scheduler} = await fresh(
      caps({openPrs: 1, inFlightBuilds: 1}),
      1
    );
    await addPr(db, 'o/r#7', 'o/r', 7);
    await observed(db, 'o/r#7', snapshot('OPEN', 'PENDING'));
    await addPr(db, 'o/r#new', 'o/r', null);

    assert.deepEqual(await dispatchedPrs(scheduler, NOW), []);

    // Closing the PR frees its open slot, but its jobs still hold CI.
    await observed(db, 'o/r#7', snapshot('CLOSED', 'PENDING'));
    assert.deepEqual(await dispatchedPrs(scheduler, LATER), []);

    await observed(db, 'o/r#7', snapshot('CLOSED', 'SUCCESS'));
    assert.deepEqual(await dispatchedPrs(scheduler, LATER), ['o/r#new']);
    await db.close();
  });

  it('holds a slot for a dispatched item until its PR and build show up', async () => {
    const {db, scheduler} = await fresh(caps({openPrs: 1}));
    await addPr(db, 'o/r#first', 'o/r', null);
    await addPr(db, 'o/r#second', 'o/r', null);

    assert.deepEqual(await dispatchedPrs(scheduler, NOW), ['o/r#first']);

    // The claim is the only sign the first PR is coming: without counting it,
    // every tick before that PR appears would admit another item.
    assert.deepEqual(await dispatchedPrs(scheduler, LATER), []);
    await db.close();
  });

  it('counts what it dispatches, so one pass cannot overshoot a cap', async () => {
    const {db, scheduler} = await fresh(caps({openPrs: 2}));
    for (const id of ['a', 'b', 'c']) await addPr(db, `o/r#${id}`, 'o/r', null);

    // Nothing is open yet: without reserving each dispatch against the cap,
    // all three would go out and open three PRs before the next tick.
    assert.deepEqual(await dispatchedPrs(scheduler, NOW), ['o/r#a', 'o/r#b']);
    await db.close();
  });

  it('never gates a ticket', async () => {
    const {db, scheduler} = await fresh(caps({openPrs: 0, inFlightBuilds: 0}));
    await new TicketStore(db).upsertTicket(baseTicket('A', 'P'));
    await addPr(db, 'o/r#new', 'o/r', null);

    const {orders} = await scheduler.tick(NOW);
    // Ticket-workers keep planning; the PR items they register wait in the
    // queue for a slot.
    assert.deepEqual(
      orders
        .filter((order) => order.kind.startsWith('dispatch_'))
        .map((order) => order.kind),
      ['dispatch_ticket']
    );
    await db.close();
  });

  it('admits a PR item no repo can be attributed to', async () => {
    const {db, scheduler} = await fresh(caps({openPrs: 0, inFlightBuilds: 0}));
    await new PrStore(db).upsertPr({
      id: 'unattributed',
      ticket: null,
      origin: 'prompt',
      repo: null,
      prNumber: null,
      url: null,
      branch: null,
      title: 'unattributed',
      injected: false,
      priority: null,
      updatedAt: null,
    });

    assert.deepEqual(await dispatchedPrs(scheduler, NOW), ['unattributed']);
    await db.close();
  });
});
