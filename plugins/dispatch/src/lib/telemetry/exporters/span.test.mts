import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {ROOT_CONTEXT, SpanStatusCode, trace} from '@opentelemetry/api';
import {
  BasicTracerProvider,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';

import {capture, parseLine} from '../test-support.mts';
import {createSpanExporter} from './span.mts';

/** A real provider, so a field this exporter reads cannot change shape under it. */
function createTracing(): {
  readLines: () => string[];
  provider: BasicTracerProvider;
} {
  const {readLines, stream} = capture();
  return {
    readLines,
    provider: new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(createSpanExporter(stream))],
    }),
  };
}

describe('createSpanExporter', () => {
  it('writes one line per span, named in the line', async () => {
    const {readLines, provider} = createTracing();

    const tracer = provider.getTracer('probe');
    tracer.startSpan('first').end();
    tracer.startSpan('second').end();
    await provider.shutdown();

    assert.deepEqual(
      readLines().map((line) => {
        const {fields, signal} = parseLine(line);
        return [signal, fields.name];
      }),
      [
        ['span', 'first'],
        ['span', 'second'],
      ]
    );
  });

  it('carries the ids and duration needed to place the span in a trace', async () => {
    const {readLines, provider} = createTracing();

    const span = provider.getTracer('probe').startSpan('work');
    const {spanId, traceId} = span.spanContext();
    span.end();
    await provider.shutdown();

    const [line] = readLines();
    assert.ok(line);
    const {fields} = parseLine(line);
    assert.equal(fields.trace, traceId);
    assert.equal(fields.span, spanId);
    assert.equal(fields.kind, 'INTERNAL');
    assert.equal(typeof fields.durationMs, 'number');
    assert.equal(fields.scope, 'probe');
  });

  it('omits the fields a plain span has nothing to say about', async () => {
    const {readLines, provider} = createTracing();

    provider.getTracer('probe').startSpan('bare').end();
    await provider.shutdown();

    const [line] = readLines();
    assert.ok(line);
    const {fields} = parseLine(line);
    assert.deepEqual(
      ['attributes', 'events', 'links', 'message', 'parent', 'status'].filter(
        (key) => key in fields
      ),
      []
    );
  });

  it('reports a failed span with its status and message', async () => {
    const {readLines, provider} = createTracing();

    const span = provider.getTracer('probe').startSpan('work');
    span.setAttribute('pr', 270);
    span.setStatus({code: SpanStatusCode.ERROR, message: 'gh exited 1'});
    span.end();
    await provider.shutdown();

    const [line] = readLines();
    assert.ok(line);
    const {fields} = parseLine(line);
    assert.equal(fields.status, 'ERROR');
    assert.equal(fields.message, 'gh exited 1');
    assert.deepEqual(fields.attributes, {pr: 270});
  });

  it('carries the events a span recorded', async () => {
    // `recordException` is an event, so a line without events loses it.
    const {readLines, provider} = createTracing();

    const span = provider.getTracer('probe').startSpan('work');
    span.recordException(new Error('gh exited 1'));
    span.end();
    await provider.shutdown();

    const [line] = readLines();
    assert.ok(line);
    assert.match(line, /gh exited 1/u);
  });

  it('names the parent of a child span', async () => {
    const {readLines, provider} = createTracing();

    const tracer = provider.getTracer('probe');
    const parent = tracer.startSpan('tick');
    tracer
      .startSpan('poll', undefined, trace.setSpan(ROOT_CONTEXT, parent))
      .end();
    parent.end();
    await provider.shutdown();

    const [first] = readLines();
    assert.ok(first);
    assert.equal(parseLine(first).fields.parent, parent.spanContext().spanId);
  });

  it('keeps a span whose name holds a newline on one line', async () => {
    // A name in the prefix rather than inside the JSON would split this record
    // in two and leave the second half unparseable.
    const {readLines, provider} = createTracing();

    provider.getTracer('probe').startSpan('two\nlines').end();
    await provider.shutdown();

    assert.equal(readLines().length, 1);
    const [line] = readLines();
    assert.ok(line);
    assert.equal(parseLine(line).fields.name, 'two\nlines');
  });
});
