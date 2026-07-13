import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {logRecords, runDispatch} from '../../test-harness.mts';

describe('dispatch greet', () => {
  it('greets the positional name on stdout', async () => {
    const {code, stdout} = await runDispatch(['greet', 'World']);

    assert.equal(stdout, 'hello World\n');
    assert.equal(code, 0);
  });

  it('greets the --name flag value', async () => {
    const {code, stdout} = await runDispatch(['greet', '--name', 'Ada']);

    assert.equal(stdout, 'hello Ada\n');
    assert.equal(code, 0);
  });

  it('keeps the greeting on stdout and the logs on stderr', async () => {
    const {stdout, stderr} = await runDispatch(['greet', 'World']);

    assert.equal(stdout, 'hello World\n');
    assert.doesNotMatch(stdout, /level=/u, 'stdout must stay pipe-clean');

    const records = logRecords(stderr);
    assert.ok(
      records.some(
        (record) => record.msg === 'greeted' && record.name === 'World'
      ),
      `expected a greeted record on stderr, got: ${stderr}`
    );
  });

  it('greets a name containing spaces without splitting it', async () => {
    const {code, stdout, stderr} = await runDispatch([
      'greet',
      '--name',
      'Ada Lovelace',
    ]);

    assert.equal(stdout, 'hello Ada Lovelace\n');
    assert.equal(code, 0);

    const greeted = logRecords(stderr).find(
      (record) => record.msg === 'greeted'
    );
    assert.equal(
      greeted?.name,
      'Ada Lovelace',
      'a value with a space must survive logfmt quoting round-trip'
    );
  });

  it('greets a name that looks like a flag when passed after --', async () => {
    const {code, stdout} = await runDispatch(['greet', '--', '--name']);

    assert.equal(stdout, 'hello --name\n');
    assert.equal(code, 0);
  });

  it('rejects a missing name with a usage error', async () => {
    const {code, stdout, stderr} = await runDispatch(['greet']);

    assert.equal(code, 2);
    assert.equal(stdout, '');
    assert.match(stderr, /^error: greet requires a name$/mu);
    assert.match(stderr, /usage: dispatch greet <name>/u);
  });

  it('rejects an empty name', async () => {
    const {code, stdout} = await runDispatch(['greet', '--name', '']);

    assert.equal(code, 2);
    assert.equal(stdout, '');
  });

  it('rejects a second name rather than silently ignoring it', async () => {
    const {code, stdout, stderr} = await runDispatch(['greet', 'Ada', 'Grace']);

    assert.equal(code, 2);
    assert.equal(stdout, '');
    assert.match(stderr, /at most one name/u);
  });

  it('rejects an unknown flag', async () => {
    const {code, stderr} = await runDispatch(['greet', '--shout', 'World']);

    assert.equal(code, 2);
    assert.match(stderr, /--shout/u);
    assert.doesNotMatch(stderr, /at .*\.mts:\d+/u, 'a bad flag is not a crash');
  });
});
