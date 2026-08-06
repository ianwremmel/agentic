import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import type {ChannelSink} from '../../lib/command/index.mts';
import {createLogger} from '../../lib/logger/index.mts';
import type {CoreLogger} from '../../lib/logger/logger.mts';
import {Command} from './ping.mts';

function sink(): {
  channel: ChannelSink;
  pushes: {kind: string; meta: Record<string, string | null>; body: string}[];
} {
  const pushes: {
    kind: string;
    meta: Record<string, string | null>;
    body: string;
  }[] = [];
  return {
    channel: {
      push: (kind, meta, content) => {
        pushes.push({kind, meta: {...meta}, body: content});
      },
    },
    pushes,
  };
}

/** A logger sink that discards everything, whatever levels exist. */
function silentSink(): CoreLogger {
  return new Proxy({} as CoreLogger, {
    get: () => () => undefined,
  });
}

function context(channel?: ChannelSink) {
  let out = '';
  return {
    ctx: {
      log: createLogger(silentSink()),
      env: {},
      io: {
        write: (chunk: string) => {
          out += chunk;
        },
      },
      channel,
    },
    read: () => out,
  };
}

describe('mcp ping', () => {
  it('pushes a pong carrying the nonce it reports', async () => {
    const {channel, pushes} = sink();
    const {ctx, read} = context(channel);
    await new Command().run({nonce: 'abc123'}, ctx);

    // The tool result proves the call arrived; the push is what proves
    // delivery. They must carry the same nonce or the two cannot be tied to
    // one round trip.
    assert.equal(pushes.length, 1);
    const [pushed] = pushes;
    assert.ok(pushed !== undefined);
    assert.equal(pushed.kind, 'pong');
    assert.equal(pushed.meta.nonce, 'abc123');
    assert.match(read(), /ping abc123 pushed/u);
  });

  it('mints a nonce when none is given', async () => {
    const {channel, pushes} = sink();
    const {ctx} = context(channel);
    await new Command().run({}, ctx);
    const [pushed] = pushes;
    assert.ok(pushed !== undefined);
    const nonce = pushed.meta.nonce;
    assert.ok(typeof nonce === 'string' && nonce.length > 0);
  });

  it('pushes nothing and says why when there is no channel', async () => {
    const {ctx, read} = context(undefined);
    await new Command().run({nonce: 'abc123'}, ctx);
    // Over the CLI there is no session to push to, so reporting success
    // would assert something the run never tested.
    assert.match(read(), /no-channel/u);
  });
});
