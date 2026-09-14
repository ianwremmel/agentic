import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {SeverityNumber} from '@opentelemetry/api-logs';
import {
  LoggerProvider,
  SimpleLogRecordProcessor,
} from '@opentelemetry/sdk-logs';

import {capture, parseLine} from '../test-support.mts';
import {createLogRecordExporter} from './log.mts';

/** A real provider, so a field this exporter reads cannot change shape under it. */
function createLogging(): {
  readLines: () => string[];
  provider: LoggerProvider;
} {
  const {readLines, stream} = capture();
  return {
    readLines,
    provider: new LoggerProvider({
      processors: [
        new SimpleLogRecordProcessor({
          exporter: createLogRecordExporter(stream),
        }),
      ],
    }),
  };
}

describe('createLogRecordExporter', () => {
  it('carries the severity and the body', async () => {
    const {readLines, provider} = createLogging();

    provider.getLogger('probe').emit({
      attributes: {pr: 'ianwremmel/agentic#270'},
      body: 'watch armed',
      severityNumber: SeverityNumber.INFO,
      severityText: 'INFO',
    });
    await provider.shutdown();

    const [line] = readLines();
    assert.ok(line);
    const {fields, signal} = parseLine(line);
    assert.equal(signal, 'log');
    assert.equal(fields.severity, 'INFO');
    assert.equal(fields.body, 'watch armed');
    assert.deepEqual(fields.attributes, {pr: 'ianwremmel/agentic#270'});
  });

  it('falls back to the severity number when no text was given', async () => {
    const {readLines, provider} = createLogging();

    provider
      .getLogger('probe')
      .emit({body: 'no text', severityNumber: SeverityNumber.WARN});
    await provider.shutdown();

    const [line] = readLines();
    assert.ok(line);
    assert.equal(parseLine(line).fields.severity, 'WARN');
  });

  it('calls a record carrying neither severity field UNSPECIFIED', async () => {
    const {readLines, provider} = createLogging();

    provider.getLogger('probe').emit({body: 'bare'});
    await provider.shutdown();

    const [line] = readLines();
    assert.ok(line);
    assert.equal(parseLine(line).fields.severity, 'UNSPECIFIED');
  });
});
