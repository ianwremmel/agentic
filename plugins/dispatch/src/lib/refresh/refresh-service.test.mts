import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {ticket} from '../command/test-support.mts';
import {Database} from '../db/database.mts';
import {UsageError} from '../errors/index.mts';
import {
  CursorStore,
  EdgeStore,
  FetchRequestStore,
  ProjectStore,
  RefreshStore,
  SessionStore,
  TicketStore,
} from '../stores/index.mts';
import {RefreshService} from './refresh-service.mts';

const AT = '2026-08-01T12:00:00.000Z';

/**
 * A clock that advances a second per read. Under a frozen one a refresh that is
 * reopened and closed again writes back the `completed_at` it already had, so
 * an unwanted reopen is indistinguishable from leaving the row alone.
 */
function advancingClock(): () => string {
  let seconds = 0;
  return () => {
    seconds += 1;
    return new Date(Date.parse(AT) + seconds * 1000).toISOString();
  };
}

interface Harness {
  db: Database;
  service: RefreshService;
  requests: FetchRequestStore;
  refreshes: RefreshStore;
  cursors: CursorStore;
  tickets: TicketStore;
  edges: EdgeStore;
  sessions: SessionStore;
}

async function fresh(): Promise<Harness> {
  const db = await Database.open(':memory:');
  await new ProjectStore(db).upsertProject({
    id: 'P',
    name: 'P',
    source: 'linear',
  });
  return {
    db,
    service: new RefreshService(db, advancingClock()),
    requests: new FetchRequestStore(db),
    refreshes: new RefreshStore(db),
    cursors: new CursorStore(db),
    tickets: new TicketStore(db),
    edges: new EdgeStore(db),
    sessions: new SessionStore(db),
  };
}

describe('RefreshService', () => {
  it('starts a scan carrying the persisted cursor', async () => {
    const h = await fresh();
    await h.cursors.setCursor('linear', 'tok');
    await h.service.startScan({
      source: 'linear',
      projects: ['P'],
      sessionId: null,
      rebuild: false,
    });
    const [request] = await h.requests.undelivered();
    assert(request !== undefined);
    assert.equal(request.kind, 'scan_project');
    assert.deepEqual(request.payload, {projects: ['P'], cursor: 'tok'});
    await h.db.close();
  });

  it('emits nothing for a placeholder written during a scan', async () => {
    const h = await fresh();
    await h.service.startScan({
      source: 'linear',
      projects: ['P'],
      sessionId: null,
      rebuild: false,
    });
    await h.tickets.upsertTicket(ticket('T1', 'P'));
    await h.edges.addEdge('MISSING', 'T1');
    await h.service.reconcile();
    const kinds = (await h.requests.undelivered()).map((r) => r.kind);
    assert.deepEqual(kinds, ['scan_project']);
    await h.db.close();
  });

  it('completing a scan with a dangling id asks for exactly that id and holds the cursor', async () => {
    const h = await fresh();
    await h.service.startScan({
      source: 'linear',
      projects: ['P'],
      sessionId: null,
      rebuild: false,
    });
    await h.tickets.upsertTicket(ticket('T1', 'P'));
    await h.edges.addEdge('MISSING', 'T1');
    const result = await h.service.completeScan({
      source: 'linear',
      cursor: 'tok',
    });
    assert.equal(result.state, 'resolving');
    assert.deepEqual(result.pending, ['MISSING']);
    assert.equal(await h.cursors.getCursor('linear'), null);
    await h.db.close();
  });

  it('completing a clean scan closes the refresh and writes the cursor', async () => {
    const h = await fresh();
    await h.service.startScan({
      source: 'linear',
      projects: ['P'],
      sessionId: null,
      rebuild: false,
    });
    await h.tickets.upsertTicket(ticket('T1', 'P'));
    const result = await h.service.completeScan({
      source: 'linear',
      cursor: 'tok',
    });
    assert.equal(result.state, 'idle');
    assert.equal(await h.cursors.getCursor('linear'), 'tok');
    await h.db.close();
  });

  it('writing the requested ticket satisfies the request and closes the refresh', async () => {
    const h = await fresh();
    await h.service.startScan({
      source: 'linear',
      projects: ['P'],
      sessionId: null,
      rebuild: false,
    });
    await h.tickets.upsertTicket(ticket('T1', 'P'));
    await h.edges.addEdge('MISSING', 'T1');
    await h.service.completeScan({source: 'linear', cursor: 'tok'});
    await h.tickets.upsertTicket(ticket('MISSING', 'P'));
    await h.service.reconcile();
    assert.equal((await h.refreshes.get('linear'))?.state, 'idle');
    assert.equal(await h.cursors.getCursor('linear'), 'tok');
    await h.db.close();
  });

  it('markMissing satisfies the request without materializing, and the id is not asked for again', async () => {
    const h = await fresh();
    await h.service.startScan({
      source: 'linear',
      projects: ['P'],
      sessionId: null,
      rebuild: false,
    });
    await h.tickets.upsertTicket(ticket('T1', 'P'));
    await h.edges.addEdge('GONE', 'T1');
    await h.edges.addEdge('LATER', 'T1');
    await h.service.completeScan({source: 'linear', cursor: 'tok'});

    await h.service.markMissing('GONE');
    // The refresh stays open on LATER, and GONE is still an unknown node.
    assert.equal((await h.refreshes.get('linear'))?.state, 'resolving');
    assert.equal(await h.tickets.getTicket('GONE'), null);

    // A fresh reference to GONE inside the same refresh asks for nothing more.
    await h.tickets.upsertTicket(ticket('T2', 'P'));
    await h.edges.addEdge('GONE', 'T2');
    await h.service.reconcile();
    assert.deepEqual(
      (await h.requests.openTickets()).map((t) => t.ticket),
      ['LATER']
    );
    await h.db.close();
  });

  it('reconcile does not reopen a refresh whose only outstanding id was marked missing', async () => {
    const h = await fresh();
    await h.service.startScan({
      source: 'linear',
      projects: ['P'],
      sessionId: null,
      rebuild: false,
    });
    await h.tickets.upsertTicket(ticket('T1', 'P'));
    await h.edges.addEdge('GONE', 'T1');
    await h.service.completeScan({source: 'linear', cursor: 'tok'});
    await h.service.markMissing('GONE');
    const closed = await h.refreshes.get('linear');
    assert(closed !== null);

    await h.service.reconcile();

    const after = await h.refreshes.get('linear');
    assert(after !== null);
    assert.equal(after.state, 'idle');
    assert.notEqual(after.completedAt, null);
    assert.equal(after.completionEmittedAt, null);
    // The whole row, not just the state: a reopen that closed again inside the
    // same reconcile leaves the state alone and only the timestamps to show it.
    assert.deepEqual(after, closed);

    const goneRequests = (await h.requests.bySource('linear')).filter(
      (r) =>
        r.kind === 'fetch_ticket' &&
        'ticket' in r.payload &&
        r.payload.ticket === 'GONE'
    );
    assert.equal(goneRequests.length, 1);
    assert.equal(goneRequests[0]?.resolution, 'missing');
    await h.db.close();
  });

  it('owes no further completion once a missing tombstone is all that remains', async () => {
    const h = await fresh();
    await h.service.startScan({
      source: 'linear',
      projects: ['P'],
      sessionId: null,
      rebuild: false,
    });
    await h.tickets.upsertTicket(ticket('T1', 'P'));
    await h.edges.addEdge('GONE', 'T1');
    await h.service.completeScan({source: 'linear', cursor: 'tok'});
    await h.service.markMissing('GONE');
    // The drain has pushed the completion, so the closed refresh no longer
    // owes one and the guard that protects an unannounced completion is spent.
    await h.refreshes.markCompletionEmitted('linear', AT);
    const closed = await h.refreshes.get('linear');

    await h.service.reconcile();
    await h.service.reconcile();
    await h.service.reconcile();

    // The tombstone and its `unknown` node are permanent, so a source that
    // reopened on them would announce a completed graph on every later write.
    assert.deepEqual(await h.refreshes.get('linear'), closed);
    assert.deepEqual(await h.refreshes.pendingCompletions(), []);
    await h.db.close();
  });

  it('holds a chase back while the closed refresh still owes its completion', async () => {
    const h = await fresh();
    await h.service.startScan({
      source: 'linear',
      projects: ['P'],
      sessionId: null,
      rebuild: false,
    });
    await h.tickets.upsertTicket(ticket('T1', 'P'));
    await h.service.completeScan({source: 'linear', cursor: 'tok'});
    const closed = await h.refreshes.get('linear');
    assert(closed !== null);
    assert.equal(closed.completionEmittedAt, null);

    // A write lands between the close and the drain.
    await h.tickets.upsertTicket(ticket('T2', 'P'));
    await h.edges.addEdge('NEW', 'T2');
    await h.service.reconcile();

    assert.deepEqual(await h.refreshes.get('linear'), closed);
    assert.deepEqual(await h.refreshes.pendingCompletions(), ['linear']);
    assert.deepEqual(await h.requests.openTickets(), []);

    // Nothing is dropped: once the completion is out, the next write chases it.
    await h.refreshes.markCompletionEmitted('linear', AT);
    await h.service.reconcile();
    assert.equal((await h.refreshes.get('linear'))?.state, 'resolving');
    assert.deepEqual(
      (await h.requests.openTickets()).map((request) => request.ticket),
      ['NEW']
    );
    await h.db.close();
  });

  it('leaves a placeholder no edge ties to a tracker alone', async () => {
    const h = await fresh();
    // The design expects this during a scan: `edge add A B` before either
    // endpoint is written reaches no project, so no tracker can be asked.
    await h.edges.addEdge('A', 'B');
    await h.service.reconcile();
    assert.deepEqual(await h.requests.openTickets(), []);
    assert.equal(await h.refreshes.get('linear'), null);
    await h.db.close();
  });

  it('leaves a placeholder alone when its project names no tracker', async () => {
    const h = await fresh();
    await new ProjectStore(h.db).upsertProject({id: 'P0', name: 'P0'});
    await h.tickets.upsertTicket(ticket('T0', 'P0'));
    await h.edges.addEdge('ORPHAN', 'T0');

    await h.service.reconcile();

    // A project with no `source` resolves to no tracker at all; enqueueing
    // against one would address an instruction to nobody.
    assert.deepEqual(await h.requests.openTickets(), []);
    assert.deepEqual(await h.refreshes.active(), []);
    await h.db.close();
  });

  it('re-offers the instructions a resumed refresh already had delivered', async () => {
    const h = await fresh();
    await h.sessions.register({id: 'S1', startedAt: AT, heartbeatAt: AT});
    const input = {
      source: 'linear',
      projects: ['P'],
      sessionId: 'S1',
      rebuild: false,
    };
    await h.service.startScan(input);
    const [queued] = await h.requests.undelivered();
    assert(queued !== undefined);
    await h.requests.markDelivered(queued.id, AT);
    assert.deepEqual(await h.requests.undelivered(), []);

    const result = await h.service.startScan(input);

    // The session asked again because it is holding nothing; a scan row the
    // drain has already ticked off would never reach it a second time.
    assert.equal(result.resumed, true);
    assert.deepEqual(
      (await h.requests.undelivered()).map((request) => request.id),
      [queued.id]
    );
    await h.db.close();
  });

  it('does not re-offer a scan the agent has already reported finished', async () => {
    const h = await fresh();
    await h.sessions.register({id: 'S1', startedAt: AT, heartbeatAt: AT});
    const input = {
      source: 'linear',
      projects: ['P'],
      sessionId: 'S1',
      rebuild: false,
    };
    await h.service.startScan(input);
    await h.tickets.upsertTicket(ticket('T1', 'P'));
    await h.edges.addEdge('MISSING', 'T1');
    await h.service.completeScan({source: 'linear', cursor: 'tok'});
    for (const request of await h.requests.undelivered()) {
      await h.requests.markDelivered(request.id, AT);
    }

    await h.service.startScan(input);

    // Only the outstanding fetch comes back: re-scanning would end in a
    // `refresh done` the CLI refuses, the refresh having left `scanning`.
    assert.deepEqual(
      (await h.requests.undelivered()).map((request) => request.kind),
      ['fetch_ticket']
    );
    await h.db.close();
  });

  it('rejects markMissing for an id nobody asked for', async () => {
    const h = await fresh();
    await assert.rejects(
      h.service.markMissing('NOPE'),
      (err: unknown) => err instanceof UsageError
    );
    await h.db.close();
  });

  it('a placeholder written while idle opens a resolving refresh', async () => {
    const h = await fresh();
    await h.tickets.upsertTicket(ticket('T1', 'P'));
    await h.edges.addEdge('MISSING', 'T1');
    await h.service.reconcile();
    assert.equal((await h.refreshes.get('linear'))?.state, 'resolving');
    assert.deepEqual(
      (await h.requests.openTickets()).map((t) => t.ticket),
      ['MISSING']
    );
    await h.db.close();
  });

  it('rebuild drops the graph and scans with no cursor', async () => {
    const h = await fresh();
    await h.cursors.setCursor('linear', 'tok');
    await h.tickets.upsertTicket(ticket('T1', 'P'));
    await h.service.startScan({
      source: 'linear',
      projects: ['P'],
      sessionId: null,
      rebuild: true,
    });
    const [request] = await h.requests.undelivered();
    assert(request !== undefined);
    assert.deepEqual(request.payload, {projects: ['P'], cursor: null});
    assert.equal(await h.tickets.getTicket('T1'), null);
    await h.db.close();
  });

  it("rebuild clears every source's cursor, not only the one being rebuilt", async () => {
    const h = await fresh();
    await new ProjectStore(h.db).upsertProject({
      id: 'P2',
      name: 'P2',
      source: 'work-ticket',
    });
    await h.cursors.setCursor('linear', 'tok1');
    await h.cursors.setCursor('work-ticket', 'tok2');
    await h.service.startScan({
      source: 'linear',
      projects: ['P'],
      sessionId: null,
      rebuild: true,
    });
    assert.equal(await h.cursors.getCursor('linear'), null);
    assert.equal(await h.cursors.getCursor('work-ticket'), null);
    await h.db.close();
  });

  it('refuses to complete a scan that was never started', async () => {
    const h = await fresh();
    await assert.rejects(
      h.service.completeScan({source: 'linear', cursor: null}),
      (err: unknown) => err instanceof UsageError
    );
    await h.db.close();
  });

  it('treats a closed-but-unannounced refresh as busy while a live session owns it', async () => {
    const h = await fresh();
    await h.sessions.register({
      id: 'S1',
      startedAt: AT,
      heartbeatAt: AT,
    });
    await h.service.startScan({
      source: 'linear',
      projects: ['P'],
      sessionId: 'S1',
      rebuild: false,
    });
    await h.tickets.upsertTicket(ticket('T1', 'P'));
    await h.service.completeScan({source: 'linear', cursor: 'tok'});
    const closed = await h.refreshes.get('linear');
    assert(closed !== null);
    assert.equal(closed.state, 'idle');
    assert.notEqual(closed.completedAt, null);
    assert.equal(closed.completionEmittedAt, null);

    const result = await h.service.startScan({
      source: 'linear',
      projects: ['P'],
      sessionId: 'S1',
      rebuild: false,
    });
    assert.equal(result.resumed, true);
    // A takeover would clear and re-enqueue; nothing here was touched.
    assert.deepEqual(await h.refreshes.get('linear'), closed);
    assert.deepEqual(await h.requests.bySource('linear'), []);
    await h.db.close();
  });

  it('takes over a closed-but-unannounced refresh when no live session owns it', async () => {
    const h = await fresh();
    await h.service.startScan({
      source: 'linear',
      projects: ['P'],
      sessionId: null,
      rebuild: false,
    });
    await h.tickets.upsertTicket(ticket('T1', 'P'));
    await h.service.completeScan({source: 'linear', cursor: 'tok'});
    const closed = await h.refreshes.get('linear');
    assert(closed !== null);
    assert.equal(closed.state, 'idle');
    assert.notEqual(closed.completedAt, null);
    assert.equal(closed.completionEmittedAt, null);

    const result = await h.service.startScan({
      source: 'linear',
      projects: ['P'],
      sessionId: null,
      rebuild: false,
    });
    assert.equal(result.resumed, false);
    const [request] = await h.requests.undelivered();
    assert(request !== undefined);
    assert.equal(request.kind, 'scan_project');
    await h.db.close();
  });
});
