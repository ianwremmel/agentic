import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {ticket as baseTicket} from '../command/test-support.mts';
import {Database} from '../db/database.mts';
import {
  CoordinationStore,
  MilestoneStore,
  PrStore,
  ProjectStore,
  ReviewStore,
  SessionStore,
  TicketStore,
} from '../stores/index.mts';
import {DEFAULT_STALE_AFTER_SECONDS} from '../graph/index.mts';
import {Scheduler} from './scheduler.mts';
import type {WorkOrder} from './scheduler.mts';

const NOW = '2026-08-03T12:00:00.000Z';
const LATER = '2026-08-03T12:01:00.000Z';

async function fresh(opts: {acked?: boolean} = {}): Promise<{
  db: Database;
  scheduler: Scheduler;
}> {
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
  if (opts.acked !== false) await sessions.ack('S1', 'claude-1', NOW);
  return {db, scheduler: new Scheduler(db, {session: 'S1'})};
}

function kinds(orders: WorkOrder[]): string[] {
  return orders.map((order) => order.kind);
}

describe('Scheduler', () => {
  it('emits no work order before the acknowledgement', async () => {
    const {db, scheduler} = await fresh({acked: false});
    await new TicketStore(db).upsertTicket(baseTicket('A', 'P'));

    const {orders} = await scheduler.tick(NOW);
    assert.deepEqual(orders, []);
    await db.close();
  });

  it('claims before it emits, so a second session cannot double-dispatch', async () => {
    const {db, scheduler} = await fresh();
    await new TicketStore(db).upsertTicket(baseTicket('A', 'P'));

    const first = await scheduler.tick(NOW);
    assert.deepEqual(kinds(first.orders), ['dispatch_ticket']);
    assert.equal(first.orders[0]?.meta.ticket, 'A');

    const sessions = new SessionStore(db);
    await sessions.register({
      id: 'S2',
      startedAt: NOW,
      heartbeatAt: NOW,
      claudeSessionId: 'claude-2',
    });
    await sessions.ack('S2', 'claude-2', NOW);
    const rival = new Scheduler(db, {session: 'S2'});
    const second = await rival.tick(NOW);
    assert.deepEqual(second.orders, []);
    await db.close();
  });

  it('does not re-emit for a node it already claimed', async () => {
    const {db, scheduler} = await fresh();
    await new TicketStore(db).upsertTicket(baseTicket('A', 'P'));

    await scheduler.tick(NOW);
    const again = await scheduler.tick(LATER);
    assert.deepEqual(again.orders, []);
    await db.close();
  });

  it('admits only up to free compute capacity', async () => {
    const {db, scheduler} = await fresh();
    const tickets = new TicketStore(db);
    for (const id of ['A', 'B', 'C', 'D']) {
      await tickets.upsertTicket(baseTicket(id, 'P'));
    }
    await new CoordinationStore(db).claim({
      node: 'A',
      session: 'S1',
      claimedAt: NOW,
    });

    const {orders} = await scheduler.tick(NOW);
    assert.equal(
      orders.filter((order) => order.kind === 'dispatch_ticket').length,
      2
    );
    await db.close();
  });

  it('counts live claims against the cap across ticks', async () => {
    const {db, scheduler} = await fresh();
    const tickets = new TicketStore(db);
    for (const id of ['A', 'B', 'C', 'D']) {
      await tickets.upsertTicket(baseTicket(id, 'P'));
    }

    const first = await scheduler.tick(NOW);
    assert.deepEqual(kinds(first.orders), [
      'dispatch_ticket',
      'dispatch_ticket',
      'dispatch_ticket',
    ]);

    // The three claims are live obligations, and a claim is the compute
    // grant: no fresh budget next tick.
    const second = await scheduler.tick(LATER);
    assert.deepEqual(second.orders, []);

    // Recording an outcome releases its claim, freeing exactly one admission.
    await new CoordinationStore(db).recordOutcome(
      {
        node: String(first.orders[0]?.meta.ticket),
        outcome: 'canceled',
        retryable: null,
        detail: null,
        recordedAt: LATER,
      },
      {session: 'S1'}
    );
    const third = await scheduler.tick(LATER);
    assert.deepEqual(kinds(third.orders), ['dispatch_ticket']);
    assert.equal(third.orders[0]?.meta.ticket, 'D');
    await db.close();
  });

  it("re-dispatches a dead session's claimed node and refunds its budget", async () => {
    const {db, scheduler} = await fresh();
    const tickets = new TicketStore(db);
    for (const id of ['A', 'B', 'C', 'D']) {
      await tickets.upsertTicket(baseTicket(id, 'P'));
    }
    // A claim under a session that stopped heartbeating is nobody's
    // obligation: the stale sweep cascades it, so the node returns to the
    // queue and its admission comes back.
    await new SessionStore(db).register({
      id: 'DEAD',
      startedAt: '2020-01-01T00:00:00Z',
      heartbeatAt: '2020-01-01T00:00:00Z',
    });
    await new CoordinationStore(db).claim({
      node: 'A',
      session: 'DEAD',
      claimedAt: '2020-01-01T00:00:00Z',
    });

    const {orders} = await scheduler.tick(NOW);
    const dispatched = orders
      .filter((order) => order.kind === 'dispatch_ticket')
      .map((order) => order.meta.ticket);
    assert.deepEqual(dispatched, ['A', 'B', 'C']);
    await db.close();
  });

  it('dispatches a milestone review once per open gate', async () => {
    const {db, scheduler} = await fresh();
    await new MilestoneStore(db).upsertMilestone({
      id: 'M1',
      project: 'P',
      name: 'M1',
    });
    await new TicketStore(db).upsertTicket({
      ...baseTicket('T1', 'P'),
      status: 'verified',
    });
    const {EdgeStore} = await import('../stores/index.mts');
    await new EdgeStore(db).addEdge('T1', 'M1');

    const first = await scheduler.tick(NOW);
    assert.deepEqual(kinds(first.orders), ['perform_milestone_review']);

    const while_claimed = await scheduler.tick(LATER);
    assert.deepEqual(while_claimed.orders, []);

    // Recording the review finishes the project's last open work.
    await new ReviewStore(db).record('M1', LATER, 'S1');
    const after = await scheduler.tick(LATER);
    assert.deepEqual(kinds(after.orders), ['project_complete']);
    await db.close();
  });

  it('bounds review orders by the shared budget, reviews first', async () => {
    const {db, scheduler} = await fresh();
    const tickets = new TicketStore(db);
    const milestones = new MilestoneStore(db);
    const {EdgeStore} = await import('../stores/index.mts');
    const edges = new EdgeStore(db);
    for (const n of ['1', '2', '3', '4']) {
      await milestones.upsertMilestone({
        id: `M${n}`,
        project: 'P',
        name: `M${n}`,
      });
      await tickets.upsertTicket({
        ...baseTicket(`T${n}`, 'P'),
        status: 'verified',
      });
      await edges.addEdge(`T${n}`, `M${n}`);
    }
    await tickets.upsertTicket(baseTicket('A', 'P'));

    // Four open gates and one available ticket against a cap of 3: reviews
    // spend the budget first and the ticket waits.
    const {orders} = await scheduler.tick(NOW);
    const dispatched = orders.filter(
      (order) =>
        order.kind === 'perform_milestone_review' ||
        order.kind === 'dispatch_ticket'
    );
    assert.deepEqual(kinds(dispatched), [
      'perform_milestone_review',
      'perform_milestone_review',
      'perform_milestone_review',
    ]);
    await db.close();
  });

  it('fires park, alert, and complete once per episode and re-fires on a new one', async () => {
    const {db, scheduler} = await fresh();
    const tickets = new TicketStore(db);
    await tickets.upsertTicket({
      ...baseTicket('H', 'P'),
      requiresHuman: true,
    });

    const first = await scheduler.tick(NOW);
    assert.deepEqual(kinds(first.orders), ['park_human_blocked']);

    const second = await scheduler.tick(LATER);
    assert.deepEqual(second.orders, []);

    // Parking it ends the episode; unparking starts a new one.
    await tickets.upsertTicket({
      ...baseTicket('H', 'P'),
      requiresHuman: true,
      status: 'awaiting-external',
    });
    await scheduler.tick(LATER);
    await tickets.upsertTicket({
      ...baseTicket('H', 'P'),
      requiresHuman: true,
    });
    const reparked = await scheduler.tick(LATER);
    assert.deepEqual(kinds(reparked.orders), ['park_human_blocked']);
    await db.close();
  });

  it('announces completion when a project goes terminal', async () => {
    const {db, scheduler} = await fresh();
    await new TicketStore(db).upsertTicket({
      ...baseTicket('A', 'P'),
      status: 'verified',
    });

    const {orders} = await scheduler.tick(NOW);
    assert.deepEqual(kinds(orders), ['project_complete']);
    assert.equal(orders[0]?.meta.project, 'P');
    await db.close();
  });

  it('alerts a non-retryable failure once', async () => {
    const {db, scheduler} = await fresh();
    await new TicketStore(db).upsertTicket(baseTicket('A', 'P'));
    await new CoordinationStore(db).recordOutcome(
      {
        node: 'A',
        outcome: 'failed',
        retryable: false,
        detail: 'exploded',
        recordedAt: NOW,
      },
      {session: 'S1'}
    );

    const first = await scheduler.tick(NOW);
    assert.deepEqual(kinds(first.orders), ['alert_failure']);
    const second = await scheduler.tick(LATER);
    assert.deepEqual(second.orders, []);
    await db.close();
  });

  it('alerts a PR item waiting on an operator response once, until requeued', async () => {
    const {db, scheduler} = await fresh();
    await new PrStore(db).upsertPr({
      id: 'o/r#7',
      ticket: null,
      origin: 'prompt',
      repo: 'o/r',
      prNumber: 7,
      url: null,
      branch: null,
      title: 'bare',
      injected: false,
      priority: null,
      updatedAt: null,
    });
    await new CoordinationStore(db).recordOutcome(
      {
        node: 'o/r#7',
        outcome: 'human-blocked',
        retryable: null,
        detail: 'which auth flow?',
        recordedAt: NOW,
      },
      {session: 'S1'}
    );

    const first = await scheduler.tick(NOW);
    const alerts = first.orders.filter(
      (order) => order.kind === 'alert_failure'
    );
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0]?.meta.pr, 'o/r#7');
    assert.match(alerts[0].body, /operator response/);
    assert.ok(
      !first.orders.some((order) => order.kind === 'park_human_blocked'),
      'a PR item has no status to park'
    );

    const second = await scheduler.tick(LATER);
    assert.ok(
      !second.orders.some((order) => order.kind === 'alert_failure'),
      'the alert fires once per episode'
    );

    // The operator answered and removed the outcome: the item requeues.
    await new CoordinationStore(db).removeOutcome('o/r#7', {
      now: LATER,
      staleAfterSeconds: DEFAULT_STALE_AFTER_SECONDS,
    });
    const third = await scheduler.tick(LATER);
    assert.deepEqual(
      third.orders
        .filter((order) => order.kind === 'dispatch_pr')
        .map((order) => order.meta.pr),
      ['o/r#7']
    );
    await db.close();
  });

  it('reports retirement when its session row is gone', async () => {
    const {db, scheduler} = await fresh();
    await new SessionStore(db).close('S1');

    const result = await scheduler.tick(NOW);
    assert.equal(result.retired, true);
    assert.deepEqual(result.orders, []);
    await db.close();
  });
});
