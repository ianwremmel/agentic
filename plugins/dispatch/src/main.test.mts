import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {Writable} from 'node:stream';
import {describe, it} from 'node:test';
import {promisify} from 'node:util';

import {discover} from './lib/command/index.mts';
import {runCli} from './lib/cli/index.mts';
import {createLogger, type CoreLogger} from './lib/logger/index.mts';

const execFileAsync = promisify(execFile);

const COMMANDS = new URL('./commands/', import.meta.url);
const MAIN = fileURLToPath(new URL('./main.mts', import.meta.url));

/** `dispatch greet World` as its own process, which is the only way to see
 * which stream each byte landed on. */
async function greet(
  env: NodeJS.ProcessEnv = {}
): Promise<{stderr: string; stdout: string}> {
  return execFileAsync(process.execPath, [MAIN, 'greet', 'World'], {
    env: {...process.env, ...env},
  });
}

describe('src/commands tree', () => {
  it('discovers and runs the greet command', async () => {
    const tree = await discover(COMMANDS);
    const sink = {} as CoreLogger;
    for (const level of [
      'error',
      'warn',
      'info',
      'debug',
      'trace',
      'log',
    ] as const) {
      sink[level] = () => {
        // no-op: greet's output goes to stdout via io, not the logger
      };
    }
    const noop = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    const out: string[] = [];
    const sink2 = new Writable({
      write(chunk, _encoding, callback) {
        out.push(String(chunk));
        callback();
      },
    });

    const code = await runCli({
      argv: ['greet', 'Ada', '--loud'],
      tree,
      log: createLogger(sink),
      env: {},
      stdout: sink2,
      stderr: noop,
    });

    assert.equal(code, 0);
    assert.equal(out.join(''), 'HELLO ADA\n');
  });

  it('discovers the mcp command but excludes it from the generated tools', async () => {
    const {buildTools} = await import('./lib/mcp/index.mts');
    const tree = await discover(COMMANDS);
    assert.ok(tree.children.has('mcp'), 'the mcp command is discovered');
    const {byName} = buildTools(tree);
    assert.ok(!byName.has('mcp'), 'but it opts out of its own transport');
    assert.ok(byName.has('greet'));
  });
});

describe('telemetry in the running CLI', () => {
  it('stays silent on a command that emits nothing', async () => {
    // Telemetry is always on, so "always on" has to also mean quiet: an
    // exporter that announced itself, or a diag logger left at a default
    // level, would put a line in front of every command an agent runs. Where
    // the records go once there are records is
    // `lib/telemetry/telemetry.test.mts`.
    assert.deepEqual(await greet(), {stderr: '', stdout: 'hello World\n'});
  });

  it('keeps stdout clean when the SDK is asked to explain itself', async () => {
    // `NodeSDK`'s constructor installs `DiagConsoleLogger` when
    // `OTEL_LOG_LEVEL` is set, and the line announcing that logger goes
    // through it to stdout — so a stderr logger installed afterwards is too
    // late. Asserting on stdout is the only way to catch that ordering.
    const {stderr, stdout} = await greet({OTEL_LOG_LEVEL: 'debug'});

    assert.equal(stdout, 'hello World\n');
    assert.match(stderr, /^otel debug /mu);
  });
});
