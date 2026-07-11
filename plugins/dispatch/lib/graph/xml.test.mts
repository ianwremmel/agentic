/**
 * Tests for the XML reader/writer and the delta it parses.
 *
 * The parser is strict on purpose: a document that half-parses would mis-schedule
 * a whole run, so malformed input must throw rather than yield a plausible graph.
 */

import assert from 'node:assert/strict';
import {test} from 'node:test';

import {readDelta} from './delta.mts';
import {writeDocument} from './document.mts';
import {derive} from './derive.mts';
import {bool, el, num, parse, serialize} from './xml.mts';

test('an element round-trips through serialize and parse', () => {
  const tree = el('root', {a: '1'}, [el('child', {b: 'two'})]);
  const back = parse(serialize(tree));
  assert.equal(back.name, 'root');
  assert.equal(back.attrs.a, '1');
  assert.equal(back.children[0]!.attrs.b, 'two');
});

test('markup in an attribute survives the round trip', () => {
  const title = `Fix <script> & "quotes" in 'titles'`;
  const back = parse(serialize(el('node', {title})));
  assert.equal(back.attrs.title, title);
});

test('undefined attributes are omitted rather than written as "undefined"', () => {
  assert.equal(serialize(el('node', {id: 'A', url: undefined})), '<node id="A"/>');
});

test('comments and the XML declaration are skipped', () => {
  const back = parse('<?xml version="1.0"?>\n<!-- a note -->\n<root x="1"/>');
  assert.equal(back.attrs.x, '1');
});

test('malformed documents throw instead of parsing to something plausible', () => {
  assert.throws(() => parse('<a><b/>'), /unclosed <a>/);
  assert.throws(() => parse('<a></b>'), /closes <a>/);
  assert.throws(() => parse('<a/><b/>'), /trailing content/);
  assert.throws(() => parse('<a x=1/>'), /expected quoted value/);
  assert.throws(() => parse('<a>text</a>'), /unexpected text content/);
  assert.throws(() => parse('<a x="&bogus;"/>'), /unknown XML entity/);
});

test('typed attribute readers reject junk rather than yielding NaN or false', () => {
  assert.equal(bool(parse('<a f="true"/>'), 'f'), true);
  assert.equal(bool(parse('<a/>'), 'f'), undefined);
  assert.throws(() => bool(parse('<a f="yes"/>'), 'f'), /must be true or false/);
  assert.equal(num(parse('<a n="3"/>'), 'n'), 3);
  assert.throws(() => num(parse('<a n="x"/>'), 'n'), /must be a number/);
});

test('a delta parses into nodes, edges, milestones, and a cursor', () => {
  const delta = readDelta(`
    <project-graph-delta cursor="2026-07-11T18:04:00Z">
      <projects><project id="p1" name="API"/></projects>
      <milestones><milestone id="m1" project="p1" order="1" review-recorded="false"/></milestones>
      <nodes>
        <node id="DEV-1" url="https://x/1" title="Schema" role="available" group="unstarted"
              project="p1" milestone="m1" target-kind="pr" human-interactive="false">
          <label name="needs-human"/>
          <pr url="https://gh/1"/>
        </node>
      </nodes>
      <edges>
        <edge blocker="DEV-0" blocked="DEV-1"/>
        <edges-for node="DEV-1"/>
      </edges>
    </project-graph-delta>
  `);

  assert.equal(delta.cursor, '2026-07-11T18:04:00Z');
  assert.equal(delta.nodes![0]!.title, 'Schema');
  assert.deepEqual(delta.nodes![0]!.labels, ['needs-human']);
  assert.deepEqual(delta.nodes![0]!.pr_urls, ['https://gh/1']);
  assert.deepEqual(delta.edges, [{blocker: 'DEV-0', blocked: 'DEV-1'}]);
  assert.deepEqual(delta.edges_for, ['DEV-1']);
});

test('an absent attribute is absent, not an undefined that would erase the cache', () => {
  const delta = readDelta('<project-graph-delta><nodes><node id="A" role="available"/></nodes></project-graph-delta>');
  assert.deepEqual(
    Object.keys(delta.nodes![0]!).sort(),
    ['id', 'role'],
    'merge spreads these over the cached node; an own `undefined` would blank the cached value',
  );
});

test('a milestone without a project is refused', () => {
  assert.throws(
    () =>
      readDelta(
        '<project-graph-delta><milestones><milestone id="m1" order="1"/></milestones></project-graph-delta>',
      ),
    /has no project/,
    'project-less milestones would otherwise share one pseudo-project and gate each other',
  );
});

test('an empty numeric attribute is refused rather than read as zero', () => {
  assert.throws(
    () =>
      readDelta(
        '<project-graph-delta><milestones><milestone id="m" project="p" order=""/></milestones></project-graph-delta>',
      ),
    /must be a number/,
    'order="" would become 0 and gate every other milestone in the project',
  );
});

test('an empty label or pr is refused rather than emitted as a blank', () => {
  const wrap = (inner: string) => `<project-graph-delta><nodes><node id="A" role="available">${inner}</node></nodes></project-graph-delta>`;
  assert.throws(() => readDelta(wrap('<label/>')), /has no name/);
  assert.throws(() => readDelta(wrap('<pr/>')), /has no url/);
});

test('a bare ampersand is refused: an unescaped title must not parse to a wrong value', () => {
  assert.throws(() => parse('<a t="Tom & Jerry"/>'), /bare '&'/);
});

test('a duplicate attribute is refused rather than silently last-wins', () => {
  assert.throws(() => parse('<a x="1" x="2"/>'), /duplicate attribute/);
});

test('an out-of-range character reference is a parse error, not a crash', () => {
  assert.throws(() => parse('<a t="&#9999999;"/>'), /invalid character reference/);
});

test('a newline in a title survives the round trip', () => {
  const back = parse(serialize(el('node', {title: 'line one\nline two'})));
  assert.equal(back.attrs.title, 'line one\nline two', 'a raw newline would break a conformant reader');
});

test('an unmapped tracker substate is rejected, not guessed at', () => {
  assert.throws(
    () => readDelta('<project-graph-delta><nodes><node id="A" role="Doing"/></nodes></project-graph-delta>'),
    /unknown role "Doing"/,
  );
});

test('a self-blocking edge is refused at read time', () => {
  assert.throws(
    () => readDelta('<project-graph-delta><edges><edge blocker="A" blocked="A"/></edges></project-graph-delta>'),
    /self-blocking/,
  );
});

test('the wrong root element is refused', () => {
  assert.throws(() => readDelta('<project-graph/>'), /expected <project-graph-delta>/);
});

test('the document exposes every section the orchestrator schedules from', () => {
  const doc = derive({
    cursor: 'T1',
    projects: [{id: 'p1'}],
    milestones: [{id: 'm1', project: 'p1', order: 1}],
    nodes: [
      {id: 'A', role: 'available', group: 'unstarted', project: 'p1', milestone: 'm1', title: 'Do <the> work'},
      {id: 'H', role: 'available', group: 'unstarted', project: 'p1', target_kind: 'human-only'},
    ],
    edges: [],
  });
  const xml = writeDocument(doc);
  const root = parse(xml);

  assert.equal(root.name, 'project-graph');
  assert.equal(root.attrs.cursor, 'T1');
  for (const section of ['available', 'blocked', 'human-blocked', 'permanently-blocked', 'stalled', 'anomalies']) {
    assert.ok(
      root.children.some((c) => c.name === section),
      `<${section}> must be emitted even when empty — a missing section reads as "nothing to do"`,
    );
  }

  const available = root.children.find((c) => c.name === 'available')!;
  assert.deepEqual(available.children.map((c) => c.attrs.id), ['A']);
  assert.equal(available.attrs.count, '1');

  const node = root.children
    .find((c) => c.name === 'nodes')!
    .children.find((n) => n.attrs.id === 'A')!;
  assert.equal(node.attrs.title, 'Do <the> work', 'a title with markup must survive for the status table');
});
