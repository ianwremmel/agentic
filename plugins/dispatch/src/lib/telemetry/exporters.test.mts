import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {ROOT_CONTEXT, SpanStatusCode, trace} from '@opentelemetry/api';
import {SeverityNumber} from '@opentelemetry/api-logs';
import {
  LoggerProvider,
  SimpleLogRecordProcessor,
} from '@opentelemetry/sdk-logs';
import {
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import {
  BasicTracerProvider,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';

import {
  stderrLogRecordExporter,
  stderrMetricExporter,
  stderrSpanExporter,
} from './exporters.mts';
import {capture, parse} from './test-support.mts';

/**
 * Records come from real SDK providers rather than hand-built literals: a fake
 * `ReadableSpan` would let a field these exporters read change shape under
 * them. Each provider is local, so nothing here registers a global and the
 * tests stay independent of each other.
 */
function tracing(): {
  lines: () => string[];
  provider: BasicTracerProvider;
} {
  const {lines, stream} = capture();
  return {
    lines,
    provider: new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(stderrSpanExporter(stream))],
    }),
  };
}

function metering(): {lines: () => string[]; provider: MeterProvider} {
  const {lines, stream} = capture();
  return {
    lines,
    provider: new MeterProvider({
      readers: [
        new PeriodicExportingMetricReader({
          exporter: stderrMetricExporter(stream),
        }),
      ],
    }),
  };
}

function logging(): {lines: () => string[]; provider: LoggerProvider} {
  const {lines, stream} = capture();
  return {
    lines,
    provider: new LoggerProvider({
      processors: [
        new SimpleLogRecordProcessor({
          exporter: stderrLogRecordExporter(stream),
        }),
      ],
    }),
  };
}

describe('stderrSpanExporter', () => {
  it('writes one line per span, named in the line', async () => {
    const {lines, provider} = tracing();

    const tracer = provider.getTracer('probe');
    tracer.startSpan('first').end();
    tracer.startSpan('second').end();
    await provider.shutdown();

    assert.deepEqual(
      lines().map((line) => {
        const {fields, signal} = parse(line);
        return [signal, fields.name];
      }),
      [
        ['span', 'first'],
        ['span', 'second'],
      ]
    );
  });

  it('carries the ids and duration needed to place the span in a trace', async () => {
    const {lines, provider} = tracing();

    const span = provider.getTracer('probe').startSpan('work');
    const {spanId, traceId} = span.spanContext();
    span.end();
    await provider.shutdown();

    const [line] = lines();
    assert.ok(line);
    const {fields} = parse(line);
    assert.equal(fields.trace, traceId);
    assert.equal(fields.span, spanId);
    assert.equal(fields.kind, 'INTERNAL');
    assert.equal(typeof fields.durationMs, 'number');
    assert.equal(fields.scope, 'probe');
  });

  it('omits the fields a plain span has nothing to say about', async () => {
    // The line is read by a human, so an unparented span with no attributes
    // and no status has to stay short rather than carry three nulls.
    const {lines, provider} = tracing();

    provider.getTracer('probe').startSpan('bare').end();
    await provider.shutdown();

    const [line] = lines();
    assert.ok(line);
    const {fields} = parse(line);
    assert.deepEqual(
      ['attributes', 'message', 'parent', 'status'].filter(
        (key) => key in fields
      ),
      []
    );
  });

  it('reports a failed span with its status and message', async () => {
    const {lines, provider} = tracing();

    const span = provider.getTracer('probe').startSpan('work');
    span.setAttribute('pr', 270);
    span.setStatus({code: SpanStatusCode.ERROR, message: 'gh exited 1'});
    span.end();
    await provider.shutdown();

    const [line] = lines();
    assert.ok(line);
    const {fields} = parse(line);
    assert.equal(fields.status, 'ERROR');
    assert.equal(fields.message, 'gh exited 1');
    assert.deepEqual(fields.attributes, {pr: 270});
  });

  it('names the parent of a child span', async () => {
    const {lines, provider} = tracing();

    const tracer = provider.getTracer('probe');
    const parent = tracer.startSpan('tick');
    tracer
      .startSpan('poll', undefined, trace.setSpan(ROOT_CONTEXT, parent))
      .end();
    parent.end();
    await provider.shutdown();

    const [first] = lines();
    assert.ok(first);
    assert.equal(parse(first).fields.parent, parent.spanContext().spanId);
  });

  it('keeps a span whose name holds a newline on one line', async () => {
    // A span name is arbitrary text, and the whole format is one record per
    // line. A name in the prefix rather than inside the JSON would split this
    // record in two and leave the second half unparseable.
    const {lines, provider} = tracing();

    provider.getTracer('probe').startSpan('two\nlines').end();
    await provider.shutdown();

    assert.equal(lines().length, 1);
    const [line] = lines();
    assert.ok(line);
    assert.equal(parse(line).fields.name, 'two\nlines');
  });
});

describe('stderrMetricExporter', () => {
  it('writes one line per data point, named in the line', async () => {
    const {lines, provider} = metering();

    const counter = provider.getMeter('probe').createCounter('orders', {
      unit: '{order}',
    });
    counter.add(2, {kind: 'dispatch_pr'});
    counter.add(1, {kind: 'dispatch_ticket'});
    await provider.shutdown();

    assert.deepEqual(
      lines().map((line) => {
        const {fields, signal} = parse(line);
        return [
          signal,
          fields.name,
          fields.type,
          fields.unit,
          fields.value,
          fields.attributes,
        ];
      }),
      [
        ['metric', 'orders', 'SUM', '{order}', 2, {kind: 'dispatch_pr'}],
        ['metric', 'orders', 'SUM', '{order}', 1, {kind: 'dispatch_ticket'}],
      ]
    );
  });

  it('omits the unit of an instrument that declares none', async () => {
    const {lines, provider} = metering();

    provider.getMeter('probe').createCounter('claims').add(1);
    await provider.shutdown();

    const [line] = lines();
    assert.ok(line);
    assert.ok(!('unit' in parse(line).fields));
  });
});

describe('stderrLogRecordExporter', () => {
  it('carries the severity and the body', async () => {
    const {lines, provider} = logging();

    provider.getLogger('probe').emit({
      attributes: {pr: 'ianwremmel/agentic#270'},
      body: 'watch armed',
      severityNumber: SeverityNumber.INFO,
      severityText: 'INFO',
    });
    await provider.shutdown();

    const [line] = lines();
    assert.ok(line);
    const {fields, signal} = parse(line);
    assert.equal(signal, 'log');
    assert.equal(fields.severity, 'INFO');
    assert.equal(fields.body, 'watch armed');
    assert.deepEqual(fields.attributes, {pr: 'ianwremmel/agentic#270'});
  });

  it('falls back to the severity number when no text was given', async () => {
    const {lines, provider} = logging();

    provider
      .getLogger('probe')
      .emit({body: 'no text', severityNumber: SeverityNumber.WARN});
    await provider.shutdown();

    const [line] = lines();
    assert.ok(line);
    assert.equal(parse(line).fields.severity, 'WARN');
  });

  it('calls a record carrying neither severity field UNSPECIFIED', async () => {
    const {lines, provider} = logging();

    provider.getLogger('probe').emit({body: 'bare'});
    await provider.shutdown();

    const [line] = lines();
    assert.ok(line);
    assert.equal(parse(line).fields.severity, 'UNSPECIFIED');
  });
});
