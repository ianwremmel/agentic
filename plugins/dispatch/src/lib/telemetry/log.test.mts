import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {beforeEach, describe, it} from 'node:test';
import {promisify} from 'node:util';

import {SeverityNumber} from '@opentelemetry/api-logs';

import {log} from './log.mts';
import {buildChildEnv, captureLogs} from './test-support.mts';

const execFileAsync = promisify(execFile);

const INDEX = new URL('./index.mts', import.meta.url).href;

const recorded = captureLogs();

beforeEach(() => {
  recorded.reset();
});

/** The one record the test just produced. */
function only(): {
  attributes: Record<string, unknown>;
  body: unknown;
  severityNumber: SeverityNumber | undefined;
  severityText: string | undefined;
} {
  const records = recorded.read();
  assert.equal(records.length, 1);
  const [record] = records;
  assert.ok(record !== undefined);
  return {
    attributes: record.attributes,
    body: record.body,
    severityNumber: record.severityNumber,
    severityText: record.severityText,
  };
}

describe('log', () => {
  it('carries the message as the body and the fields as attributes', () => {
    log.warn('watch armed without a baseline snapshot', {node: 'owner/repo#7'});

    const {attributes, body} = only();
    assert.equal(body, 'watch armed without a baseline snapshot');
    assert.deepEqual(attributes, {node: 'owner/repo#7'});
  });

  it('gives each level both a number and the text a backend groups on', () => {
    log.debug('held');
    log.info('adopted');
    log.warn('slow');
    log.error('failed');

    assert.deepEqual(
      recorded
        .read()
        .map((record) => [record.severityNumber, record.severityText]),
      [
        [SeverityNumber.DEBUG, 'DEBUG'],
        [SeverityNumber.INFO, 'INFO'],
        [SeverityNumber.WARN, 'WARN'],
        [SeverityNumber.ERROR, 'ERROR'],
      ]
    );
  });

  describe('the exception variants', () => {
    it('records the type, message, and stack of a thrown Error', () => {
      // The stack is the reason this is not `{error: error.message}`: it is
      // what says which of a function's several `gh` calls threw.
      log.errorException('watch poll failed', new TypeError('boom'), {
        node: 'owner/repo#7',
      });

      const {attributes, severityNumber} = only();
      assert.equal(severityNumber, SeverityNumber.ERROR);
      assert.equal(attributes['exception.type'], 'TypeError');
      assert.equal(attributes['exception.message'], 'boom');
      const stack = attributes['exception.stacktrace'];
      assert.ok(typeof stack === 'string');
      assert.match(stack, /log\.test\.mts/u);
      assert.equal(attributes.node, 'owner/repo#7');
    });

    it('keeps a failure the caller absorbed at warn', () => {
      // A backend routes on severity, so a degradation the caller went on to
      // work around must not read like a tick that died.
      log.warnException('adoption listing failed', new Error('gh: 502'), {
        repo: 'owner/repo',
      });

      const {attributes, severityNumber, severityText} = only();
      assert.equal(severityNumber, SeverityNumber.WARN);
      assert.equal(severityText, 'WARN');
      assert.equal(attributes['exception.message'], 'gh: 502');
    });

    it('keeps a thrown string as the exception message', () => {
      log.errorException('watch poll failed', 'gh: not found');

      assert.equal(only().attributes['exception.message'], 'gh: not found');
    });

    it('stringifies a thrown value the conventions cannot describe', () => {
      // Without this the record would carry no exception attributes at all and
      // say only that something failed. `{message: ''}` is the boundary: the
      // SDK tests these properties for truthiness, not for presence.
      const unrecordable = [undefined, false, {}, {message: ''}, {code: 0}];
      for (const [at, thrown] of unrecordable.entries()) {
        recorded.reset();
        log.errorException('watch poll failed', thrown);
        assert.equal(
          typeof only().attributes['exception.message'],
          'string',
          `case ${String(at)} produced no exception message`
        );
      }
    });

    it('reports rather than throws when the thrown value cannot be read', () => {
      // Every caller is inside a `catch`, so a throw here would replace the
      // failure being reported with a failure to report it.
      const hostile = {
        get code(): never {
          throw new Error('nope');
        },
      };
      log.errorException('watch poll failed', hostile);

      assert.match(
        String(only().attributes['exception.message']),
        /could not be read/u
      );
    });

    it('survives a value String() itself refuses', () => {
      log.errorException('watch poll failed', Object.create(null));

      assert.match(
        String(only().attributes['exception.message']),
        /could not be read/u
      );
    });
  });

  it('reaches the stream once the SDK starts, having been resolved before it', async () => {
    // `log` holds its logger from module load, which is before `startTelemetry`
    // registers anything — every consumer imports it that early. What makes
    // that work is the API's proxy, and this is the assertion that it does.
    const {stderr, stdout} = await execFileAsync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `const {log, startTelemetry} = await import(${JSON.stringify(INDEX)});
         log.error('before the sdk');
         const telemetry = await startTelemetry({stream: process.stderr});
         log.error('after the sdk', {node: 'owner/repo#7'});
         await telemetry.shutdown();`,
      ],
      {env: buildChildEnv()}
    );

    assert.equal(stdout, '');
    const lines = stderr.split('\n').filter((line) => line.startsWith('log '));
    assert.equal(lines.length, 1);
    assert.match(lines[0] ?? '', /"severity":"ERROR"/u);
    assert.match(lines[0] ?? '', /"body":"after the sdk"/u);
    assert.match(lines[0] ?? '', /"node":"owner\/repo#7"/u);
  });
});
