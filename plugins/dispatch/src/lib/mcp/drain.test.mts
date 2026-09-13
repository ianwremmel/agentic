import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {tempEnv} from '../command/test-support.mts';
import {withDatabase} from '../db/index.mts';
import {RefreshService} from '../refresh/index.mts';
import {FetchRequestStore} from '../stores/index.mts';
import {ChannelWriter} from './channel.mts';
import {drainInstructions} from './drain.mts';

interface Notification {
  method: string;
  params: {content: string; meta: Record<string, string>};
}

describe('drainInstructions', () => {
  it('pushes one notification per undelivered row, with increasing seq', async () => {
    const env = await tempEnv();
    await withDatabase(undefined, env, async (db) => {
      await new RefreshService(db).startScan({
        source: 'linear',
        projects: ['P'],
        sessionId: null,
        rebuild: false,
      });
    });

    const sent: Notification[] = [];
    const channel = new ChannelWriter((payload) =>
      sent.push(payload as Notification)
    );

    assert.equal(await drainInstructions(channel, env), 1);
    assert.equal(await drainInstructions(channel, env), 0);

    assert.equal(sent.length, 1);
    const [first] = sent;
    assert.ok(first);
    assert.equal(first.method, 'notifications/claude/channel');
    assert.equal(first.params.meta.kind, 'scan_project');
    assert.equal(first.params.meta.seq, '1');
    assert.match(first.params.content, /\bP\b/);
    assert.match(
      first.params.content,
      /dispatch refresh done --tracker linear/
    );
  });

  it('pushes the completion event exactly once', async () => {
    const env = await tempEnv();
    await withDatabase(undefined, env, async (db) => {
      const service = new RefreshService(db);
      await service.startScan({
        source: 'linear',
        projects: ['P'],
        sessionId: null,
        rebuild: false,
      });
      await service.completeScan({source: 'linear', cursor: 'tok'});
    });

    const sent: Notification[] = [];
    const channel = new ChannelWriter((payload) =>
      sent.push(payload as Notification)
    );
    await drainInstructions(channel, env);
    await drainInstructions(channel, env);

    const kinds = sent.map((n) => n.params.meta.kind);
    assert.equal(kinds.filter((k) => k === 'refresh_complete').length, 1);
  });

  it('does not re-push a row already marked delivered', async () => {
    const env = await tempEnv();
    await withDatabase(undefined, env, async (db) => {
      await new RefreshService(db).startScan({
        source: 'linear',
        projects: ['P'],
        sessionId: null,
        rebuild: false,
      });
    });

    const sent: Notification[] = [];
    const channel = new ChannelWriter((payload) =>
      sent.push(payload as Notification)
    );

    await drainInstructions(channel, env);
    await drainInstructions(channel, env);
    await drainInstructions(channel, env);

    // Three drains, one delivery: a second and third pass over the same row
    // must find it already delivered, not resend it.
    assert.equal(sent.length, 1);
  });

  it('pushes nothing for an instruction that was answered in-process', async () => {
    const env = await tempEnv();
    await withDatabase(undefined, env, async (db) => {
      await new RefreshService(db).startScan({
        source: 'linear',
        projects: ['P'],
        sessionId: null,
        rebuild: false,
      });
    });

    const sent: Notification[] = [];
    const channel = new ChannelWriter((payload) =>
      sent.push(payload as Notification)
    );
    let offered = 0;
    const answered = await drainInstructions(channel, env, {
      answer: async ({db, request}) => {
        offered += 1;
        await new FetchRequestStore(db).resolveScan(request.source);
        return true;
      },
    });

    assert.equal(offered, 1);
    assert.equal(answered, 0);
    assert.equal(sent.length, 0);
  });

  it('pushes an answer that returned true without settling its own request', async () => {
    const env = await tempEnv();
    await withDatabase(undefined, env, async (db) => {
      await new RefreshService(db).startScan({
        source: 'linear',
        projects: ['P'],
        sessionId: null,
        rebuild: false,
      });
    });

    const sent: Notification[] = [];
    const channel = new ChannelWriter((payload) =>
      sent.push(payload as Notification)
    );
    // Claiming an answer while leaving the row open would hand the same row
    // back every pass and push it to nobody: the instruction would be lost and
    // the refresh could never close.
    let offered = 0;
    assert.equal(
      await drainInstructions(channel, env, {
        answer: () => {
          offered += 1;
          return Promise.resolve(true);
        },
      }),
      1
    );
    assert.equal(offered, 1);
    assert.equal(sent[0]?.params.meta.kind, 'scan_project');
  });

  it('bounds one in-process answer so a hung tracker cannot hold the read loop', async () => {
    const env = await tempEnv();
    await withDatabase(undefined, env, async (db) => {
      await new RefreshService(db).startScan({
        source: 'linear',
        projects: ['P'],
        sessionId: null,
        rebuild: false,
      });
    });

    const channel = new ChannelWriter(() => undefined);
    let signal: AbortSignal | undefined;
    await drainInstructions(channel, env, {
      answer: (input) => {
        signal = input.signal;
        return Promise.resolve(false);
      },
    });

    assert.ok(signal, 'the answer must be handed a cancellation to honour');
    assert.equal(signal.aborted, false);
  });

  it('pushes the instruction when the in-process answer declines it', async () => {
    const env = await tempEnv();
    await withDatabase(undefined, env, async (db) => {
      await new RefreshService(db).startScan({
        source: 'linear',
        projects: ['P'],
        sessionId: null,
        rebuild: false,
      });
    });

    const sent: Notification[] = [];
    const channel = new ChannelWriter((payload) =>
      sent.push(payload as Notification)
    );
    // A tracker with no client, an absent key, or a failed fetch all arrive
    // here as the same `false`, and the agent path has to still be reachable.
    assert.equal(
      await drainInstructions(channel, env, {
        answer: () => Promise.resolve(false),
      }),
      1
    );
    assert.equal(sent[0]?.params.meta.kind, 'scan_project');
  });

  it('drains the asks an in-process answer enqueues without waiting for another tick', async () => {
    const env = await tempEnv();
    await withDatabase(undefined, env, async (db) => {
      await new RefreshService(db).startScan({
        source: 'linear',
        projects: ['P'],
        sessionId: null,
        rebuild: false,
      });
    });

    const sent: Notification[] = [];
    const channel = new ChannelWriter((payload) =>
      sent.push(payload as Notification)
    );
    // The scan is answered here; the placeholder it referenced is owed in the
    // same drain, not the next one.
    await drainInstructions(channel, env, {
      answer: async ({db, request}) => {
        if (request.kind !== 'scan_project') return false;
        const requests = new FetchRequestStore(db);
        await requests.resolveScan(request.source);
        await requests.enqueueTicket({
          source: request.source,
          ticket: 'ENG-1',
          at: '2026-08-01T00:00:00Z',
        });
        return true;
      },
    });

    assert.deepEqual(
      sent.map((n) => n.params.meta.kind),
      ['fetch_ticket']
    );
  });

  it('turns a fetch_ticket row into a fetch_ticket event carrying the ticket id', async () => {
    const env = await tempEnv();
    await withDatabase(undefined, env, async (db) => {
      await new FetchRequestStore(db).enqueueTicket({
        source: 'linear',
        ticket: 'ENG-42',
        at: '2026-08-01T00:00:00Z',
      });
    });

    const sent: Notification[] = [];
    const channel = new ChannelWriter((payload) =>
      sent.push(payload as Notification)
    );
    assert.equal(await drainInstructions(channel, env), 1);

    const [first] = sent;
    assert.ok(first);
    assert.equal(first.params.meta.kind, 'fetch_ticket');
    assert.equal(first.params.meta.ticket, 'ENG-42');
    assert.match(first.params.content, /ENG-42/);
    assert.match(first.params.content, /dispatch ticket missing --id ENG-42/);
  });
});
