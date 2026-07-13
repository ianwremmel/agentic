import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {logRecords, runDispatch} from '../test-harness.mts';

await describe('dispatch', async () => {
  await it('prints help on --help and exits 0', async () => {
    const {code, stdout} = await runDispatch(['--help']);

    assert.equal(code, 0);
    assert.match(stdout, /usage: dispatch/u);
    assert.match(stdout, /^ {2}greet {2,}Print a greeting to stdout\.$/mu);
  });

  await it('rejects no command with a usage error and the command list', async () => {
    const {code, stdout, stderr} = await runDispatch([]);

    assert.equal(code, 2);
    assert.equal(stdout, '');
    assert.match(stderr, /error: no command given/u);
    assert.match(stderr, /greet/u);
  });

  await it('rejects an unknown command by name', async () => {
    const {code, stderr} = await runDispatch(['sing', 'World']);

    assert.equal(code, 2);
    assert.match(stderr, /error: unknown command "sing"/u);
    assert.match(stderr, /greet/u);
  });

  await it('logs at info by default, without debug records', async () => {
    const {stderr} = await runDispatch(['greet', 'World']);
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

  await it('emits debug records when --log-level debug is passed', async () => {
    const {code, stdout, stderr} = await runDispatch([
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

  await it('takes the log level from DISPATCH_LOG_LEVEL', async () => {
    const {code, stdout, stderr} = await runDispatch(['greet', 'World'], {
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

  await it('lets --log-level win over DISPATCH_LOG_LEVEL', async () => {
    const {stderr} = await runDispatch(
      ['--log-level', 'debug', 'greet', 'World'],
      {env: {DISPATCH_LOG_LEVEL: 'error'}}
    );

    assert.ok(
      logRecords(stderr).some((record) => record.level === 'debug'),
      'the flag must override the environment'
    );
  });

  await it('rejects an unknown log level instead of guessing one', async () => {
    const {code, stderr} = await runDispatch([
      '--log-level',
      'chatty',
      'greet',
      'W',
    ]);

    assert.equal(code, 2);
    assert.match(stderr, /unknown log level "chatty"/u);
  });

  await it('does not treat a global option value as the command name', async () => {
    const {code, stdout} = await runDispatch([
      '--log-level',
      'warn',
      'greet',
      'World',
    ]);

    assert.equal(code, 0);
    assert.equal(stdout, 'hello World\n');
  });
});
