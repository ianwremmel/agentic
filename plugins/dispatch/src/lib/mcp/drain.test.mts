import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {describe, it} from 'node:test';

import {withDatabase} from '../db/index.mts';
import {RefreshService} from '../refresh/index.mts';
import {FetchRequestStore} from '../stores/index.mts';
import {ChannelWriter} from './channel.mts';
import {drainInstructions} from './drain.mts';

interface Notification {
  method: string;
  params: {content: string; meta: Record<string, string>};
}

async function tempEnv(): Promise<NodeJS.ProcessEnv> {
  const dir = await mkdtemp(path.join(tmpdir(), 'dispatch-drain-'));
  return {DISPATCH_DB: path.join(dir, 'graph.db')};
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
