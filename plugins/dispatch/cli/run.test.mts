import assert from 'node:assert/strict';
import path from 'node:path';
import {describe, it} from 'node:test';

import {logRecords, runDispatch} from '../test-harness.mts';
import type {DispatchOptions} from '../test-harness.mts';

// The wrapper routes every command except `graph` and `wait` to the src/
// tree. These tests pin the legacy runner itself, so hold its entry fixed.
const LEGACY_ENTRY = path.join(import.meta.dirname, 'main.mts');

function runLegacy(
  args: readonly string[],
  {env = {}, ...rest}: DispatchOptions = {}
): ReturnType<typeof runDispatch> {
  return runDispatch(args, {
    ...rest,
    env: {DISPATCH_ENTRY: LEGACY_ENTRY, ...env},
  });
}

describe('dispatch', () => {
  it('prints help on --help and exits 0', async () => {
    const {code, stdout} = await runLegacy(['--help']);

    assert.equal(code, 0);
    assert.match(stdout, /usage: dispatch/u);
    assert.match(stdout, /^ {2}greet {2,}Print a greeting to stdout\.$/mu);
  });

  it('rejects no command with a usage error and the command list', async () => {
    const {code, stdout, stderr} = await runLegacy([]);

    assert.equal(code, 2);
    assert.equal(stdout, '');
    assert.match(stderr, /error: no command given/u);
    assert.match(stderr, /greet/u);
  });

  it('rejects an unknown command by name', async () => {
    const {code, stderr} = await runLegacy(['sing', 'World']);

    assert.equal(code, 2);
    assert.match(stderr, /error: unknown command "sing"/u);
    assert.match(stderr, /greet/u);
  });

  it('logs at info by default, without debug records', async () => {
    const {stderr} = await runLegacy(['greet', 'World']);
    const records = logRecords(stderr);

    assert.ok(records.length > 0, 'expected logfmt records on stderr');
    assert.ok(
      records.every((record) => record.level !== 'debug'),
      'debug records must not appear at the default level'
    );
    assert.ok(
      records.every((record) =>
        /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/u.test(record.ts ?? '')
      ),
      'every record carries an ISO-8601 ts'
    );
  });

  it('emits debug records when --log-level debug is passed', async () => {
    const {code, stdout, stderr} = await runLegacy([
      '--log-level',
      'debug',
      'greet',
      'World',
    ]);
    const records = logRecords(stderr);

    assert.equal(code, 0);
    assert.equal(stdout, 'hello World\n', 'log level must not change stdout');
    assert.ok(
      records.some((record) => record.level === 'debug'),
      `expected debug records, got: ${stderr}`
    );
  });

  it('takes the log level from DISPATCH_LOG_LEVEL', async () => {
    const {code, stdout, stderr} = await runLegacy(['greet', 'World'], {
      env: {DISPATCH_LOG_LEVEL: 'error'},
    });

    assert.equal(code, 0);
    assert.equal(stdout, 'hello World\n');
    assert.deepEqual(
      logRecords(stderr),
      [],
      'an error-level run of a successful command logs nothing'
    );
  });

  it('lets --log-level win over DISPATCH_LOG_LEVEL', async () => {
    const {stderr} = await runLegacy(
      ['--log-level', 'debug', 'greet', 'World'],
      {env: {DISPATCH_LOG_LEVEL: 'error'}}
    );

    assert.ok(
      logRecords(stderr).some((record) => record.level === 'debug'),
      'the flag must override the environment'
    );
  });

  it('rejects an unknown log level instead of guessing one', async () => {
    const {code, stderr} = await runLegacy([
      '--log-level',
      'chatty',
      'greet',
      'W',
    ]);

    assert.equal(code, 2);
    assert.match(stderr, /unknown log level "chatty"/u);
  });

  it('does not treat a global option value as the command name', async () => {
    const {code, stdout} = await runLegacy([
      '--log-level',
      'warn',
      'greet',
      'World',
    ]);

    assert.equal(code, 0);
    assert.equal(stdout, 'hello World\n');
  });
});

describe('dispatch global options after the command', () => {
  it('rejects them and says where they belong', async () => {
    const {code, stdout, stderr} = await runLegacy([
      'greet',
      '--log-level',
      'debug',
      'World',
    ]);

    assert.equal(code, 2);
    assert.equal(stdout, '', 'a misplaced global must not still greet');
    assert.match(stderr, /--log-level/u);
    assert.match(stderr, /a global option must come before the command/u);
    assert.match(stderr, /before the command/u);
  });

  it('leaves a global-looking flag after -- alone', async () => {
    const {code, stdout} = await runLegacy(['greet', '--', '--log-level']);

    assert.equal(code, 0);
    assert.equal(stdout, 'hello --log-level\n');
  });
});

describe('dispatch <command> --help', () => {
  it('prints the command usage and exits 0', async () => {
    const {code, stdout, stderr} = await runLegacy(['greet', '--help']);

    assert.equal(code, 0);
    assert.match(stdout, /^usage: dispatch greet <name>$/mu);
    assert.doesNotMatch(
      stderr,
      /global option/u,
      '--help after a command asks for that command usage, it is not misplaced'
    );
  });

  it('greets a literal --help passed after --', async () => {
    const {code, stdout} = await runLegacy(['greet', '--', '--help']);

    assert.equal(code, 0);
    assert.equal(stdout, 'hello --help\n');
  });
});
