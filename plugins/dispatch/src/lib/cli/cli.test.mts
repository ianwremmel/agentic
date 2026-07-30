import assert from 'node:assert/strict';
import {Writable} from 'node:stream';
import {describe, it} from 'node:test';

import {runCli} from './cli.mts';
import {discover} from '../command/index.mts';
import {createLogger} from '../logger/index.mts';

const FIXTURES = new URL('../command/__fixtures__/commands/', import.meta.url);

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

async function run(argv: string[], env: NodeJS.ProcessEnv = {}) {
  const tree = await discover(FIXTURES);
  const out = capture();
  const err = capture();
  const code = await runCli({
    argv,
    tree,
    log: createLogger(capture().stream as unknown as Console),
    env,
    stdout: out.stream,
    stderr: err.stream,
  });
  return {code, out: out.text(), err: err.text()};
}

describe('runCli', () => {
  it('dispatches a leaf command and applies defaults', async () => {
    const {code, out} = await run(['greet']);
    assert.equal(code, 0);
    assert.equal(out, 'hello world\n');
  });

  it('binds a positional and validates a choice', async () => {
    assert.equal((await run(['greet', 'Ada'])).out, 'hello Ada\n');
    assert.equal(
      (await run(['greet', 'Ada', '--format', 'json'])).out,
      '{"hello":"Ada"}\n'
    );
    assert.equal((await run(['greet', '--format', 'xml'])).code, 2);
  });

  it('coerces numbers and reports a missing required option', async () => {
    assert.equal(
      (await run(['math', 'add', '--a', '2', '--b', '3'])).out,
      '5\n'
    );
    assert.equal((await run(['math', 'add', '--a', '2'])).code, 2);
    assert.equal((await run(['math', 'add', '--a', 'x', '--b', '3'])).code, 2);
  });

  it('prefers a subcommand over the parent when both could match', async () => {
    assert.equal((await run(['store', 'get', 'colour'])).out, 'get colour\n');
    assert.equal((await run(['store', 'colour'])).out, 'store colour\n');
    assert.equal((await run(['store'])).out, 'store (root)\n');
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
    assert.equal(present.out, 'ok\n');

    assert.equal((await run(['needs-token'], {})).code, 3);
  });
});
