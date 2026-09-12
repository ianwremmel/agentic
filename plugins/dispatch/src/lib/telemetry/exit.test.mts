import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {Writable} from 'node:stream';
import {describe, it} from 'node:test';

import {flushOnExit} from './exit.mts';
import {capture, childEnv} from './test-support.mts';

const EXIT = new URL('./exit.mts', import.meta.url).href;

const INERT = {
  shutdown(): Promise<void> {
    return Promise.resolve();
  },
};

const EVENTS = [
  'SIGINT',
  'SIGTERM',
  'uncaughtException',
  'unhandledRejection',
] as const;

function counts(): Record<string, number> {
  return Object.fromEntries(
    EVENTS.map((event) => [event, process.listenerCount(event)])
  );
}

interface Died {
  readonly code: number | null;
  readonly signal: string | null;
  readonly stderr: string;
}

/**
 * Run a process that installs the handlers, provoke `how`, and report how it
 * died.
 *
 * Out of process because each handler's job is to end the process — a signal
 * by re-raising, a fatal error by exiting — which in-process would take this
 * test runner down with it. The telemetry handed in is a fake that marks the
 * flush and nothing more: whether a real flush gets its bytes out before the
 * process goes away is the exporters' half of the contract, covered by
 * `telemetry.test.mts`.
 */
async function died(
  how: 'signal' | 'throw' | 'reject' | 'unraisable' | 'broken-report'
): Promise<Died> {
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `const {Writable} = await import('node:stream');
       const {flushOnExit} = await import(${JSON.stringify(EXIT)});
       const how = ${JSON.stringify(how)};
       if (how === 'unraisable') {
         process.kill = () => {
           throw new Error('ESRCH');
         };
       }
       // A stream whose every write fails, to make reporting a crash itself
       // a source of crashes.
       const broken = new Writable({
         write(chunk, encoding, callback) {
           callback(new Error('EPIPE'));
         },
       });
       let flushes = 0;
       flushOnExit(
         {
           // Synchronously, not as a rejection: a throw before the promise
           // exists is the one a \`.catch()\` on the call cannot see.
           shutdown:
             how === 'broken-report'
               ? () => {
                   throw new Error('flush failed too');
                 }
               : async () => {
                   await new Promise((done) => setTimeout(done, 20));
                   process.stderr.write('flushed ' + ++flushes + '\\n');
                 },
         },
         how === 'broken-report' ? broken : process.stderr,
       );
       process.stdout.write('ready\\n');
       setInterval(() => undefined, 1_000);
       if (how === 'throw' || how === 'broken-report') {
         setTimeout(() => {
           throw new Error('from a callback nothing awaits');
         }, 50);
       }
       if (how === 'reject') {
         setTimeout(() => {
           void Promise.reject(new Error('nothing catches this'));
         }, 50);
       }`,
    ],
    {env: childEnv(), stdio: ['ignore', 'pipe', 'pipe']}
  );

  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });

  // Provoking anything before the handlers are installed would end the child
  // by default and prove nothing about them.
  child.stdout.setEncoding('utf8');
  for await (const chunk of child.stdout) {
    if (String(chunk).includes('ready')) break;
  }
  if (how === 'signal' || how === 'unraisable') child.kill('SIGTERM');

  const [code, signal] = (await once(child, 'exit')) as [
    number | null,
    string | null,
  ];
  return {code, signal, stderr};
}

/** The child's flush markers, in order. */
function flushes(stderr: string): string[] {
  return stderr.split('\n').filter((line) => line.startsWith('flushed '));
}

describe('flushOnExit', () => {
  it('installs one handler per exit path and takes them all back off', () => {
    // Left installed, the signal handlers would swallow the next signal and
    // the fatal handlers would suppress a crash the caller wanted.
    const {stream} = capture();
    const before = counts();

    const uninstall = flushOnExit(INERT, stream);

    assert.deepEqual(
      counts(),
      Object.fromEntries(
        Object.entries(before).map(([event, n]) => [event, n + 1])
      )
    );

    uninstall();

    assert.deepEqual(counts(), before);
  });

  it('guards the stream before a handler can write to it', () => {
    const stream = new Writable({
      write(_chunk, _encoding, callback) {
        callback(new Error('EPIPE'));
      },
    });

    const uninstall = flushOnExit(INERT, stream);
    uninstall();

    assert.equal(stream.listenerCount('error'), 1);
  });

  it('still exits 1 when both the report and the flush fail', async () => {
    // Reporting a crash must not be able to cause one. Here the stream errors
    // on every write and the flush throws on top of it, so an unguarded
    // handler re-enters itself through its own `error` and `unhandledRejection`
    // — and either loops until the runner's timeout or exits some other way.
    const {code, signal} = await died('broken-report');

    assert.deepEqual({code, signal}, {code: 1, signal: null});
  });

  it('flushes on SIGTERM and still dies from it', async () => {
    // Installing a listener suppresses the default kill, so the handler has to
    // re-raise or a signalled `dispatch mcp` would hang instead of exiting.
    // `code: null` with the signal named is how Node reports a process that
    // died from one rather than from an exit code.
    const {code, signal, stderr} = await died('signal');

    assert.deepEqual({code, signal}, {code: null, signal: 'SIGTERM'});
    assert.deepEqual(flushes(stderr), ['flushed 1']);
  });

  it('still exits 143 when the re-raise itself fails', async () => {
    // Re-raising is inside the handler's async body, so a throw from it would
    // reject and be picked up by this same function's `unhandledRejection`
    // handler — reporting a crash and exiting 1, turning an orderly SIGTERM
    // into a spurious bug report. Falling back to the code the signal would
    // have produced keeps the caller's view of the exit intact.
    const {code, signal, stderr} = await died('unraisable');

    assert.deepEqual({code, signal}, {code: 143, signal: null});
    assert.deepEqual(flushes(stderr), ['flushed 1']);
    assert.doesNotMatch(stderr, /unhandledRejection/u);
  });

  it('flushes on a throw from a callback nothing awaits, then exits 1', async () => {
    // The death a long-running server actually dies, and the one its
    // telemetry is there to explain. No `finally` is on the stack for it.
    const {code, signal, stderr} = await died('throw');

    assert.deepEqual({code, signal}, {code: 1, signal: null});
    assert.match(stderr, /uncaughtException: Error: from a callback/u);
    assert.deepEqual(flushes(stderr), ['flushed 1']);
  });

  it('flushes on an unhandled rejection, then exits 1', async () => {
    const {code, signal, stderr} = await died('reject');

    assert.deepEqual({code, signal}, {code: 1, signal: null});
    assert.match(stderr, /unhandledRejection: Error: nothing catches this/u);
    assert.deepEqual(flushes(stderr), ['flushed 1']);
  });
});
