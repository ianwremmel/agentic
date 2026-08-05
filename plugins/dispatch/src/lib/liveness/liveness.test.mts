import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {hostname} from 'node:os';
import {describe, it} from 'node:test';

import type {Session} from '../model/types.mts';
import {
  parseEtime,
  probeProcessStart,
  processStartIso,
  provenReused,
  withLiveProcesses,
} from './liveness.mts';

function row(overrides: Partial<Session>): Session {
  return {
    id: 'S1',
    host: 'this-host',
    pid: 1234,
    claudeSessionId: 'claude-1',
    ackedAt: null,
    startedAt: '2026-08-04T00:00:00.000Z',
    heartbeatAt: '2026-08-04T00:00:00.000Z',
    ...overrides,
  };
}

/** A pid that certainly held a process that has since exited. */
async function deadPid(): Promise<number> {
  const child = spawn('true', {stdio: 'ignore'});
  const pid = child.pid;
  assert.ok(pid !== undefined);
  await new Promise((resolve) => child.once('exit', resolve));
  return pid;
}

describe('parseEtime', () => {
  it('parses every etime shape down to seconds', () => {
    assert.equal(parseEtime('05:33'), 333);
    assert.equal(parseEtime('1:02:03'), 3723);
    assert.equal(parseEtime('2-03:04:05'), 183_845);
    assert.equal(parseEtime('   00:07\n'), 7);
    assert.equal(parseEtime('123:00:00'), 442_800);
  });

  it('rejects anything that is not exactly one etime', () => {
    assert.equal(parseEtime(''), null);
    assert.equal(parseEtime('garbage'), null);
    assert.equal(parseEtime('00:01\n00:02'), null);
    assert.equal(parseEtime('12'), null);
  });
});

describe('provenReused', () => {
  it('proves death only for a probed start decisively past the slack', () => {
    const startedAt = '2026-08-04T00:00:00.000Z';
    const registered = Date.parse(startedAt);
    assert.equal(provenReused(registered + 300_000, startedAt, 300_000), false);
    assert.equal(provenReused(registered + 300_001, startedAt, 300_000), true);
    // Earlier is delayed registration, not reuse.
    assert.equal(
      provenReused(registered - 3_600_000, startedAt, 300_000),
      false
    );
    // An unreadable registered instant proves nothing.
    assert.equal(provenReused(registered, 'not-a-date', 300_000), false);
  });
});

describe('withLiveProcesses', () => {
  it('keeps a row whose process start matches the registered one', async () => {
    const startedAt = '2026-08-04T00:00:00.000Z';
    const live = await withLiveProcesses([row({startedAt})], {
      host: 'this-host',
      probe: () => Promise.resolve(Date.parse(startedAt) + 800),
    });
    assert.equal(live.length, 1);
  });

  it('drops a row whose process is gone', async () => {
    const live = await withLiveProcesses([row({})], {
      host: 'this-host',
      probe: () => Promise.resolve('absent' as const),
    });
    assert.deepEqual(live, []);
  });

  it('drops a row when the probe itself fails — a match needs proof', async () => {
    const live = await withLiveProcesses([row({})], {
      host: 'this-host',
      probe: () => Promise.resolve('unknown' as const),
    });
    assert.deepEqual(live, []);
  });

  it('drops a row whose pid was reused by a different process', async () => {
    const live = await withLiveProcesses(
      [row({startedAt: '2026-08-04T00:00:00.000Z'})],
      {
        host: 'this-host',
        // The pid exists again, but its process started an hour after the
        // registered one — a different server.
        probe: () => Promise.resolve(Date.parse('2026-08-04T01:00:00.000Z')),
      }
    );
    assert.deepEqual(live, []);
  });

  it('drops a row whose registered start is unreadable', async () => {
    const live = await withLiveProcesses([row({startedAt: 'not-a-date'})], {
      host: 'this-host',
      probe: () => Promise.resolve(Date.now()),
    });
    assert.deepEqual(live, []);
  });

  it('drops rows it cannot vouch for rather than risk a false active', async () => {
    const unverifiable = [
      row({id: 'other-host', host: 'elsewhere'}),
      row({id: 'no-host', host: null}),
      row({id: 'no-pid', pid: null}),
    ];
    const live = await withLiveProcesses(unverifiable, {
      host: 'this-host',
      probe: () => {
        throw new Error('must not probe an unverifiable row');
      },
    });
    assert.deepEqual(live, []);
  });

  it('vouches for this very process through the real probe', async () => {
    const live = await withLiveProcesses(
      [
        row({
          host: hostname(),
          pid: process.pid,
          startedAt: processStartIso(),
        }),
      ],
      {host: hostname()}
    );
    assert.equal(live.length, 1);
  });

  it('rules out a genuinely dead pid through the real probe', async () => {
    assert.equal(await probeProcessStart(await deadPid()), 'absent');
  });
});
