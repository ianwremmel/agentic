/**
 * Tests across the whole producer: parse a real delta, merge it, derive, and read
 * the document back.
 *
 * The unit tests stop at each module's edge, and the worst bug this code has had
 * lived exactly in the seam between them — a delta that restated one attribute
 * silently erased every attribute it didn't mention. Nothing that only tests
 * `merge` with hand-built literals can catch that, because the literals cannot
 * express the shape `readDelta` actually produces.
 */

import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';

import {derive} from './derive.mts';
import {readDelta} from './delta.mts';
import {writeDocument} from './document.mts';
import {EMPTY, merge} from './merge.mts';
import {main} from './cli.mts';
import {parse} from './xml.mts';

const FULL = `
<project-graph-delta cursor="T1" full="true">
  <projects><project id="p1" name="API"/></projects>
  <milestones><milestone id="m1" project="p1" order="1"/></milestones>
  <nodes>
    <node id="DEV-1" url="https://t/1" title="Schema" role="verified" group="completed"
          project="p1" milestone="m1" target-kind="pr">
      <pr url="https://gh/1"/>
    </node>
    <node id="DEV-2" url="https://t/2" title="Endpoint" role="available" group="unstarted"
          project="p1" milestone="m1" target-kind="pr"/>
  </nodes>
  <edges>
    <edge blocker="DEV-1" blocked="DEV-2"/>
  </edges>
</project-graph-delta>`;

const load = (xml: string) => merge(structuredClone(EMPTY), readDelta(xml));

test('a delta that restates one attribute keeps the rest of the node', () => {
  const cache = load(FULL);
  const updated = merge(
    cache,
    readDelta('<project-graph-delta cursor="T2"><nodes><node id="DEV-2" role="in-progress"/></nodes></project-graph-delta>'),
  );

  const node = updated.nodes.find((n) => n.id === 'DEV-2')!;
  assert.equal(node.role, 'in-progress');
  assert.equal(node.milestone, 'm1', 'losing the milestone would open the review gate on an open ticket');
  assert.equal(node.project, 'p1', 'losing the project would make the project count as complete');
  assert.equal(node.title, 'Endpoint');
});

test('a ticket the tracker moved out of a milestone does not hold the gate open', () => {
  const cache = load(FULL);
  const done = merge(
    cache,
    readDelta('<project-graph-delta><nodes><node id="DEV-2" role="verified" group="completed"/></nodes></project-graph-delta>'),
  );
  const doc = derive(done);
  assert.equal(doc.milestones[0]!.ready_for_review, true);
  assert.equal(doc.counts.terminal, true);
});

test('an empty graph is not a finished graph', () => {
  const doc = derive(load('<project-graph-delta full="true"><projects><project id="p1"/></projects></project-graph-delta>'));
  assert.equal(
    doc.projects[0]!.counts.terminal,
    false,
    'a failed fetch returning no nodes must not read as "every project is complete"',
  );
  assert.equal(doc.counts.terminal, false);
});

test('work in flight is reported as in flight, not as stalled', () => {
  const doc = derive(load(FULL), {exclude: ['DEV-2']});
  assert.deepEqual(doc.available, [], 'DEV-2 is already being worked');
  assert.deepEqual(doc.stalled, [], 'a ticket a coordinator is building is not stalled');
  assert.equal(doc.counts.remaining, 1);
});

test('a title with markup survives the tracker, the cache, and the document', () => {
  const cache = load(
    '<project-graph-delta full="true"><nodes><node id="A" role="available" title="Fix &lt;script&gt; &amp; &quot;quotes&quot;"/></nodes></project-graph-delta>',
  );
  const xml = writeDocument(derive(cache));
  const node = parse(xml).children.find((c) => c.name === 'nodes')!.children[0]!;
  assert.equal(node.attrs.title, 'Fix <script> & "quotes"');
});

test('the CLI refreshes a run directory end to end', () => {
  const runDir = mkdtempSync(join(tmpdir(), 'project-graph-'));
  const deltaPath = join(runDir, 'delta.xml');
  writeFileSync(deltaPath, FULL);
  // The active set is dispatch-state's: DEV-2 is in flight, so it must not be
  // offered again, and it must not be reported as stalled either.
  writeFileSync(join(runDir, 'active.json'), JSON.stringify({units: {'DEV-2': {state: 'dispatched'}}, injected: []}));

  main(['refresh', '--run-dir', runDir, '--delta', deltaPath]);

  const doc = parse(readFileSync(join(runDir, 'document.xml'), 'utf8'));
  assert.equal(doc.attrs.cursor, 'T1', 'the cursor persists, or every tick would resync in full');
  assert.equal(doc.children.find((c) => c.name === 'available')!.attrs.count, '0');
  assert.equal(doc.children.find((c) => c.name === 'stalled')!.attrs.count, '0');

  const cache = JSON.parse(readFileSync(join(runDir, 'graph.json'), 'utf8')) as {cursor: string};
  assert.equal(cache.cursor, 'T1');

  // Deriving again without a fetch must not lose the cursor or the graph.
  main(['derive', '--run-dir', runDir]);
  assert.equal(parse(readFileSync(join(runDir, 'document.xml'), 'utf8')).attrs.cursor, 'T1');
});

test('an injected ticket outranks the frontier through the CLI', () => {
  const runDir = mkdtempSync(join(tmpdir(), 'project-graph-'));
  const deltaPath = join(runDir, 'delta.xml');
  writeFileSync(
    deltaPath,
    `<project-graph-delta full="true">
       <nodes>
         <node id="AAA" role="available" group="unstarted" project="p1"/>
         <node id="ZZZ" role="available" group="unstarted" project="p1"/>
       </nodes>
     </project-graph-delta>`,
  );
  writeFileSync(join(runDir, 'active.json'), JSON.stringify({units: {}, injected: ['ZZZ']}));

  main(['refresh', '--run-dir', runDir, '--delta', deltaPath]);
  const available = parse(readFileSync(join(runDir, 'document.xml'), 'utf8')).children.find(
    (c) => c.name === 'available',
  )!;
  assert.deepEqual(available.children.map((c) => c.attrs.id), ['ZZZ', 'AAA']);
});

test('a cached node with no role is refused rather than scheduled as something', () => {
  assert.throws(
    () => derive({cursor: null, projects: [], milestones: [], nodes: [{id: 'A'}], edges: []}),
    /node A has no role/,
  );
});
