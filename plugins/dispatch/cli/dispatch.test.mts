import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { promisify } from 'node:util';

const run = promisify(execFile);

const WRAPPER = join(import.meta.dirname, '..', 'scripts', 'dispatch');

let workspace: string;
let db: string;

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

/** Drive the real bash wrapper, the way a skill does. */
async function dispatch(args: string[], stdin?: string): Promise<Result> {
  try {
    const child = run(WRAPPER, [...args, '--db', db]);
    if (stdin !== undefined) {
      child.child.stdin?.end(stdin);
    }
    const { stdout, stderr } = await child;
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as {
      code?: number;
      stdout?: string;
      stderr?: string;
    };
    return {
      code: failure.code ?? -1,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? '',
    };
  }
}

const PAYLOAD = JSON.stringify({
  cursor: '2026-07-11T00:00:00.000Z',
  projects: [{ id: 'p1', name: 'Switchboard' }],
  milestones: [
    { id: 'm1', project: 'p1', name: 'M1', sortOrder: 1 },
    { id: 'm2', project: 'p1', name: 'M2', sortOrder: 2 },
  ],
  nodes: [
    {
      id: 'CLC-1',
      project: 'p1',
      state: 'Done',
      milestone: 'm1',
      blocks: ['CLC-2'],
    },
    {
      id: 'CLC-2',
      project: 'p1',
      state: 'Todo',
      milestone: 'm1',
      blockedBy: ['CLC-1'],
      url: 'https://linear.app/x/CLC-2',
    },
    { id: 'CLC-3', project: 'p1', state: 'Todo', milestone: 'm2' },
  ],
});

before(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'dispatch-cli-'));
  db = join(workspace, 'graph.sqlite');
});

after(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe('dispatch CLI', () => {
  it('ingests a payload on stdin and derives the frontier', async () => {
    const ingest = await dispatch(['graph', 'ingest', '--full'], PAYLOAD);
    assert.equal(ingest.code, 0, ingest.stderr);
    // Logs are logfmt on stderr, so stdout stays pipeable.
    assert.match(ingest.stderr, /level=info cmd=graph\.ingest/);
    assert.match(ingest.stderr, /nodes=3/);

    const doc = await dispatch(['graph', 'doc']);
    assert.equal(doc.code, 0, doc.stderr);

    // CLC-1 is done, so CLC-2 is the frontier. CLC-3 sits in a later milestone
    // whose predecessor has not been reviewed, so it is gated.
    assert.match(doc.stdout, /<ticket id="CLC-2" rank="1"/);
    assert.doesNotMatch(doc.stdout, /<ticket id="CLC-3" rank=/);
    assert.match(
      doc.stdout,
      /<ticket id="CLC-3" blocked-by="" gated-by="m1"\/>/,
    );
  });

  it('remembers the cursor across invocations', async () => {
    const cursor = await dispatch([
      'graph',
      'cursor',
      'get',
      '--source',
      'linear',
    ]);
    assert.equal(cursor.stdout.trim(), '2026-07-11T00:00:00.000Z');
  });

  it('keeps an excluded ticket out of the frontier', async () => {
    const excluded = await dispatch([
      'graph',
      'exclude',
      'add',
      '--id',
      'CLC-2',
      '--kind',
      'in-flight',
    ]);
    assert.equal(excluded.code, 0, excluded.stderr);

    const doc = await dispatch(['graph', 'doc']);
    assert.doesNotMatch(doc.stdout, /<ticket id="CLC-2" rank=/);
    // Still tracked — the cache must not go stale on in-flight work.
    assert.match(doc.stdout, /<node id="CLC-2"[^>]*excluded="in-flight"/);

    await dispatch(['graph', 'exclude', 'remove', '--id', 'CLC-2']);
    const restored = await dispatch(['graph', 'doc']);
    assert.match(restored.stdout, /<ticket id="CLC-2" rank="1"/);
  });

  it('opens the milestone gate once the review is recorded', async () => {
    // Finish the first milestone's remaining work.
    await dispatch(
      ['graph', 'ingest'],
      JSON.stringify({
        nodes: [{ id: 'CLC-2', project: 'p1', state: 'Done', milestone: 'm1' }],
      }),
    );

    const ready = await dispatch(['graph', 'doc']);
    assert.match(
      ready.stdout,
      /<milestone id="m1"[^>]*ready-for-review="true" review-recorded="false"/,
    );
    // Still gated: complete is not the same as reviewed.
    assert.match(
      ready.stdout,
      /<ticket id="CLC-3" blocked-by="" gated-by="m1"\/>/,
    );

    const recorded = await dispatch([
      'graph',
      'record-review',
      '--milestone',
      'm1',
    ]);
    assert.equal(recorded.code, 0, recorded.stderr);

    const open = await dispatch(['graph', 'doc']);
    assert.match(open.stdout, /<milestone id="m1"[^>]*review-recorded="true"/);
    assert.match(open.stdout, /<ticket id="CLC-3" rank="1"/);
  });

  it('re-blocks the gate when the review files follow-up work', async () => {
    // A review that files a ticket into the milestone reopens it, and the old
    // review no longer counts — a fresh one has to run.
    await dispatch(
      ['graph', 'ingest'],
      JSON.stringify({
        nodes: [{ id: 'CLC-9', project: 'p1', state: 'Todo', milestone: 'm1' }],
      }),
    );

    const doc = await dispatch(['graph', 'doc']);
    assert.match(
      doc.stdout,
      /<milestone id="m1"[^>]*ready-for-review="false" review-recorded="false"/,
    );
    assert.match(
      doc.stdout,
      /<ticket id="CLC-3" blocked-by="" gated-by="m1"\/>/,
    );
    // The follow-up ticket itself is workable.
    assert.match(doc.stdout, /<ticket id="CLC-9" rank="1"/);
  });

  it('emits the same derivation as JSON', async () => {
    const doc = await dispatch(['graph', 'doc', '--format', 'json']);
    assert.equal(doc.code, 0, doc.stderr);

    const parsed = JSON.parse(doc.stdout) as {
      available: { id: string; rank: number }[];
    };
    assert.equal(parsed.available[0]?.id, 'CLC-9');
  });
});

describe('failure reporting', () => {
  it('exits 4 and says how to fix an unmapped tracker state', async () => {
    const result = await dispatch(
      ['graph', 'ingest'],
      JSON.stringify({
        nodes: [{ id: 'CLC-7', project: 'p1', state: 'Ready for QA' }],
      }),
    );

    assert.equal(result.code, 4);
    assert.match(
      result.stderr,
      /no mapping for the native state "Ready for QA"/,
    );
    assert.match(result.stderr, /remedy:/);
  });

  it('exits 2 on a bad invocation, naming what it accepts', async () => {
    const unknown = await dispatch(['graph', 'nope']);
    assert.equal(unknown.code, 2);
    assert.match(unknown.stderr, /unknown command "graph nope"/);
    assert.match(unknown.stderr, /known graph commands:/);

    const badFlag = await dispatch(['graph', 'doc', '--nonsense']);
    assert.equal(badFlag.code, 2);
    assert.match(badFlag.stderr, /remedy: run `dispatch --help`/);
  });

  it('exits 2 when asked to record a review for a milestone it has never seen', async () => {
    const result = await dispatch([
      'graph',
      'record-review',
      '--milestone',
      'ghost',
    ]);

    assert.equal(result.code, 2);
    assert.match(result.stderr, /no milestone "ghost" in the graph/);
  });

  it('rejects a malformed payload instead of writing half of it', async () => {
    const result = await dispatch(['graph', 'ingest'], '{ not json');
    assert.equal(result.code, 2);
    assert.match(result.stderr, /not valid JSON/);
  });

  it('blames the caller, not itself, for an unreadable --file', async () => {
    // A mistyped path is the agent's mistake to fix. Reporting it as an internal
    // CLI bug would send the agent off to escalate its own typo.
    const result = await dispatch([
      'graph',
      'ingest',
      '--file',
      join(workspace, 'does-not-exist.json'),
    ]);

    assert.equal(result.code, 2);
    assert.match(result.stderr, /cannot read the ingest payload/);
    assert.doesNotMatch(result.stderr, /internal error/);
  });
});

describe('an empty graph', () => {
  it('is not reported as terminal', async () => {
    // `every` over zero projects is vacuously true. Reporting that would tell an
    // orchestrator its projects were finished when nothing has been ingested.
    const fresh = join(workspace, 'empty.sqlite');
    const { stdout, stderr } = await run(WRAPPER, [
      'graph',
      'doc',
      '--db',
      fresh,
    ]);

    assert.match(stdout, /<project-graph/);
    assert.match(stderr, /terminal=false/);
  });
});
