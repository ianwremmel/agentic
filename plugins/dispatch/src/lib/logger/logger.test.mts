import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {createLogger, type CoreLogger} from './logger.mts';

const LEVELS = ['error', 'warn', 'info', 'debug', 'trace', 'log'] as const;

interface Call {
  level: (typeof LEVELS)[number];
  message: string;
  meta: Record<string, unknown> | undefined;
  argCount: number;
}

/** A CoreLogger that records every call instead of writing anywhere. */
function recordingSink(): {sink: CoreLogger; calls: Call[]} {
  const calls: Call[] = [];
  const sink = {} as CoreLogger;
  for (const level of LEVELS) {
    sink[level] = (...args: [string, Record<string, unknown>?]) => {
      calls.push({
        level,
        message: args[0],
        meta: args[1],
        argCount: args.length,
      });
    };
  }
  return {sink, calls};
}

describe('createLogger', () => {
  it('forwards each level to the matching sink method', () => {
    const {sink, calls} = recordingSink();
    const logger = createLogger(sink);

    for (const level of LEVELS) {
      logger[level](`${level} happened`);
    }

    assert.deepEqual(
      calls.map((c) => [c.level, c.message]),
      LEVELS.map((level) => [level, `${level} happened`])
    );
  });

  it('passes call metadata through to the sink', () => {
    const {sink, calls} = recordingSink();

    createLogger(sink).info('saved', {id: 7});

    assert.deepEqual(calls, [
      {level: 'info', message: 'saved', meta: {id: 7}, argCount: 2},
    ]);
  });

  it('omits the metadata argument entirely when there is none', () => {
    const {sink, calls} = recordingSink();

    createLogger(sink).info('bare');

    const [call] = calls;
    assert(call);
    assert.equal(call.argCount, 1, 'sink called with message only');
    assert.equal(call.meta, undefined);
  });

  it('binds child metadata onto every subsequent call', () => {
    const {sink, calls} = recordingSink();

    createLogger(sink).child({req: 'abc'}).warn('slow');

    const [call] = calls;
    assert(call);
    assert.deepEqual(call.meta, {req: 'abc'});
  });

  it('lets bound child metadata win over a colliding call key', () => {
    const {sink, calls} = recordingSink();

    createLogger(sink).child({req: 'abc'}).info('x', {req: 'zzz', n: 1});

    const [call] = calls;
    assert(call);
    assert.deepEqual(call.meta, {req: 'abc', n: 1});
  });

  it('accumulates nested child metadata, deeper child winning', () => {
    const {sink, calls} = recordingSink();

    createLogger(sink)
      .child({a: 1, shared: 'outer'})
      .child({b: 2, shared: 'inner'})
      .info('x');

    const [call] = calls;
    assert(call);
    assert.deepEqual(call.meta, {a: 1, b: 2, shared: 'inner'});
  });

  it('does not mutate a parent when creating a child', () => {
    const {sink, calls} = recordingSink();
    const parent = createLogger(sink);

    parent.child({req: 'abc'});
    parent.info('unbound');

    const [call] = calls;
    assert(call);
    assert.equal(call.argCount, 1, 'parent stays free of child metadata');
  });

  it('defaults to console, sending info to stdout', () => {
    const original = process.stdout.write.bind(process.stdout);
    const chunks: string[] = [];
    process.stdout.write = (chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    };

    try {
      createLogger().info('hello-default-sink');
    } finally {
      process.stdout.write = original;
    }

    assert.match(chunks.join(''), /hello-default-sink/);
  });
});
