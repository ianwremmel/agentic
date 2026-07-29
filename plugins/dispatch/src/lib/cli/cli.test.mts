import assert from 'node:assert/strict';
import {Writable} from 'node:stream';
import {describe, it} from 'node:test';

import {runCli} from './cli.mts';
import {discover} from '../command/index.mts';
import {createLogger, type CoreLogger} from '../logger/index.mts';

const FIXTURES = new URL('../command/__fixtures__/commands/', import.meta.url);
const LEVELS = ['error', 'warn', 'info', 'debug', 'trace', 'log'] as const;

function capture(): {stream: Writable; text: () => string} {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });
  return {stream, text: () => chunks.join('')};
}

function recordingLog(): {
  log: ReturnType<typeof createLogger>;
  lines: string[];
} {
  const lines: string[] = [];
  const sink = {} as CoreLogger;
  for (const level of LEVELS) {
    sink[level] = (message: string) => {
      lines.push(message);
    };
  }
  return {log: createLogger(sink), lines};
}

async function run(argv: string[], env: NodeJS.ProcessEnv = {}) {
  const tree = await discover(FIXTURES);
  const out = capture();
  const err = capture();
  const {log, lines} = recordingLog();
  const code = await runCli({
    argv,
    tree,
    log,
    env,
    stdout: out.stream,
    stderr: err.stream,
  });
  return {code, out: out.text(), err: err.text(), lines};
}

describe('runCli', () => {
  it('dispatches a leaf command and applies defaults', async () => {
    const {code, lines} = await run(['greet']);
    assert.equal(code, 0);
    assert.deepEqual(lines, ['hello world']);
  });

  it('binds a positional and validates a choice', async () => {
    const named = await run(['greet', 'Ada']);
    assert.deepEqual(named.lines, ['hello Ada']);

    const json = await run(['greet', 'Ada', '--format', 'json']);
    assert.deepEqual(json.lines, ['{"hello":"Ada"}']);

    const bad = await run(['greet', '--format', 'xml']);
    assert.equal(bad.code, 2);
  });

  it('coerces numbers and reports a missing required option', async () => {
    const ok = await run(['math', 'add', '--a', '2', '--b', '3']);
    assert.deepEqual(ok.lines, ['5']);

    const missing = await run(['math', 'add', '--a', '2']);
    assert.equal(missing.code, 2);

    const nonNumber = await run(['math', 'add', '--a', 'x', '--b', '3']);
    assert.equal(nonNumber.code, 2);
  });

  it('prefers a subcommand over the parent when both could match', async () => {
    const child = await run(['store', 'get', 'colour']);
    assert.deepEqual(child.lines, ['get colour']);

    const parent = await run(['store', 'colour']);
    assert.deepEqual(parent.lines, ['store colour']);

    const root = await run(['store']);
    assert.deepEqual(root.lines, ['store (root)']);
  });

  it('exits 2 on an unknown subcommand under a namespace', async () => {
    const {code, err} = await run(['math', 'nope']);
    assert.equal(code, 2);
    assert.match(err, /nope/);
  });

  it('resolves --help to the deepest command path, position-independent', async () => {
    const trailing = await run(['math', 'add', '--help']);
    assert.equal(trailing.code, 0);
    assert.match(trailing.out, /math add/);

    const leading = await run(['--help', 'math', 'add']);
    assert.equal(leading.code, 0);
    assert.match(leading.out, /math add/);
  });

  it('exits 2 on an unknown flag or unknown command', async () => {
    assert.equal((await run(['greet', '--nope'])).code, 2);
    assert.equal((await run(['nope'])).code, 2);
  });

  it('enforces declared environment', async () => {
    const present = await run(['needs-token'], {MY_TOKEN: 'x'});
    assert.equal(present.code, 0);
    assert.deepEqual(present.lines, ['ok']);

    const missing = await run(['needs-token'], {});
    assert.equal(missing.code, 3);
  });
});
