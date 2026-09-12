import assert from 'node:assert/strict';
import {execFile, spawn} from 'node:child_process';
import {once} from 'node:events';
import {copyFile, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {after, describe, it} from 'node:test';
import {promisify} from 'node:util';

const execFileAsync = promisify(execFile);

const HERE = new URL('./', import.meta.url);
const INDEX = new URL('./index.mts', HERE).href;

/**
 * Enough stderr to overflow a pipe buffer several times over, so the writes
 * are queued rather than handed straight to the OS. The body is padded to
 * reach that with a record count that still runs quickly.
 */
const RECORDS = 5_000;
const PADDING = 'x'.repeat(400);

let scratch: string | undefined;

after(async () => {
  if (scratch) await rm(scratch, {recursive: true, force: true});
});

/**
 * `startTelemetry` in a process where `./sdk.mts` cannot load.
 *
 * This module is copied next to a throwing stub of its one dynamic import and
 * run out-of-process. In-process there is no way to make an already-resolvable
 * import fail, and stubbing the loader instead would only test the stub.
 * `telemetry.mts` imports nothing else at run time, so the copy is faithful.
 */
async function withBrokenSdk(): Promise<{stderr: string; stdout: string}> {
  scratch ??= await mkdtemp(join(tmpdir(), 'dispatch-telemetry-'));
  await copyFile(
    new URL('./telemetry.mts', HERE),
    join(scratch, 'telemetry.mts')
  );
  await writeFile(
    join(scratch, 'sdk.mts'),
    'throw new Error("Cannot find package \'@opentelemetry/sdk-node\'");\n'
  );
  const copy = pathToFileURL(join(scratch, 'telemetry.mts')).href;

  return execFileAsync(process.execPath, [
    '--input-type=module',
    '-e',
    `const {startTelemetry} = await import(${JSON.stringify(copy)});
     const telemetry = await startTelemetry({stream: process.stderr});
     await telemetry.shutdown();
     process.stdout.write('survived\\n');`,
  ]);
}

describe('startTelemetry', () => {
  it('hands back a working handle when the SDK cannot be loaded', async () => {
    // Claude Code installs a plugin's dependencies only when the directory it
    // unpacks into holds both a manifest and a lockfile, and it decides
    // whether to re-unpack by comparing version strings — so a release that
    // reuses a number leaves a payload behind whose node_modules was never
    // created. On an install like that this is the difference between losing
    // telemetry and losing every `dispatch` command.
    const {stderr, stdout} = await withBrokenSdk();

    assert.equal(stdout, 'survived\n');
    assert.match(stderr, /^telemetry unavailable: .*sdk-node/u);
  });

  it('puts every signal on the real stderr and nothing on stdout', async () => {
    // Out of process against the real streams, which is the only place the
    // routing is actually observable — an in-process test is handed a stream
    // and cannot tell that `console` was not used. It also covers the flush
    // against a real pipe, where a write is asynchronous and the buffer is
    // lost if the process ends without waiting.
    const {stderr, stdout} = await execFileAsync(process.execPath, [
      '--input-type=module',
      '-e',
      `const {startTelemetry} = await import(${JSON.stringify(INDEX)});
       const {trace, metrics} = await import('@opentelemetry/api');
       const {logs} = await import('@opentelemetry/api-logs');
       const telemetry = await startTelemetry({stream: process.stderr});
       trace.getTracer('probe').startSpan('work').end();
       metrics.getMeter('probe').createCounter('orders').add(1);
       logs.getLogger('probe').emit({body: 'armed', severityText: 'INFO'});
       await telemetry.shutdown();`,
    ]);

    assert.equal(stdout, '');
    assert.deepEqual(
      stderr
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => line.slice(0, line.indexOf(' ')))
        .sort(),
      ['log', 'metric', 'span']
    );
  });

  it('keeps a signal that asked for console off stdout', async () => {
    // `console` is a value NodeSDK accepts in its per-signal selectors, and
    // every Console*Exporter it builds writes through `console.dir` to stdout
    // — which `dispatch mcp` owns as its JSON-RPC channel. Reached here with a
    // collector also configured, which is the case where NodeSDK is otherwise
    // left to build the exporters from the environment: the span comes back on
    // stderr while the other two signals go to the collector.
    const {stderr, stdout} = await execFileAsync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `const {startTelemetry} = await import(${JSON.stringify(INDEX)});
         const {trace} = await import('@opentelemetry/api');
         const telemetry = await startTelemetry({stream: process.stderr});
         trace.getTracer('probe').startSpan('work').end();
         await telemetry.shutdown();`,
      ],
      {
        env: {
          ...process.env,
          OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318',
          OTEL_TRACES_EXPORTER: 'console',
        },
      }
    );

    assert.equal(stdout, '');
    assert.deepEqual(
      stderr
        .split('\n')
        .filter((line) => line.startsWith('span '))
        .map((line) => line.slice(0, 4)),
      ['span']
    );
  });

  it('loses nothing when the process is killed the moment the flush returns', async () => {
    // End to end over the whole chain: `flushOnExit` re-raises the signal as
    // soon as `shutdown()` resolves, so every link between `emit()` and the
    // bytes leaving has to have finished by then. It does not isolate which
    // link — `stream.test.mts` pins the drain and `sdk.test.mts` pins the
    // force-flush — but it is the only test that runs all of them against a
    // real pipe and a real signal.
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `const {flushOnExit, startTelemetry} = await import(${JSON.stringify(INDEX)});
         const {logs} = await import('@opentelemetry/api-logs');
         const telemetry = await startTelemetry({stream: process.stderr});
         flushOnExit(telemetry, process.stderr);
         const logger = logs.getLogger('probe');
         for (let i = 0; i < ${String(RECORDS)}; i++) {
           logger.emit({
             body: 'record ' + i + ' ' + ${JSON.stringify(PADDING)},
             severityText: 'INFO',
           });
         }
         process.stdout.write('ready\\n');
         setInterval(() => undefined, 1_000);`,
      ],
      {stdio: ['ignore', 'pipe', 'pipe']}
    );

    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.stdout.setEncoding('utf8');
    for await (const chunk of child.stdout) {
      if (String(chunk).includes('ready')) break;
    }
    child.kill('SIGTERM');
    const [code, signal] = (await once(child, 'exit')) as [
      number | null,
      string | null,
    ];

    assert.deepEqual({code, signal}, {code: null, signal: 'SIGTERM'});
    assert.equal(
      stderr.split('\n').filter((line) => line.startsWith('log ')).length,
      RECORDS
    );
  });
});
