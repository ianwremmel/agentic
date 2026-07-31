import assert from 'node:assert/strict';
import {Writable} from 'node:stream';
import {describe, it} from 'node:test';

import type {Runner, RunResult} from './lib/exec.mts';
import type {FileSystem} from './lib/fsx.mts';
import {run} from './run.mts';

function collector(): {stream: Writable; text: () => string} {
  let data = '';
  const stream = new Writable({
    write(chunk: Buffer | string, _enc, cb) {
      data += chunk.toString();
      cb();
    },
  });
  return {stream, text: () => data};
}

/** An in-memory FileSystem — no disk touched by the wiring test. */
function memoryFs(): FileSystem {
  const files = new Map<string, string>();
  return {
    mkdirp: () => Promise.resolve(),
    read: (path) => Promise.resolve(files.get(path)),
    write: (path, dataStr) => {
      files.set(path, dataStr);
      return Promise.resolve();
    },
    exists: (path) => Promise.resolve(files.has(path)),
  };
}

const ok = (stdout = ''): RunResult => ({code: 0, stdout, stderr: ''});

const PR_JSON = JSON.stringify({
  number: 7,
  headRefName: 'feature',
  headRefOid: 'abc',
  baseRefName: 'main',
  state: 'OPEN',
  mergedAt: null,
  mergeable: 'MERGEABLE',
  isDraft: false,
  statusCheckRollup: [
    {name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS'},
  ],
});

const COMMENTS = [
  JSON.stringify({
    id: 'C_1',
    body: 'please fix the typo',
    author: {login: 'reviewer'},
    reactions: {nodes: []},
    reactionGroups: [],
  }),
  JSON.stringify({
    id: 'C_2',
    body: '<!-- agent-plan:caller-bot -->\n1. do the thing',
    author: {login: 'caller-bot'},
    reactions: {nodes: []},
    reactionGroups: [],
  }),
].join('\n');

const REVIEWS = JSON.stringify({
  author: {login: 'copilot', __typename: 'Bot'},
  state: 'COMMENTED',
});

const THREADS = JSON.stringify([
  {
    id: 'T_1',
    isResolved: true,
    comments: {nodes: [{body: 'nit', author: {login: 'reviewer'}}]},
  },
]);

/** Fake forge: dispatch on the gh subcommand or the --jq filter it carries. */
const fakeRunner: Runner = (cmd, args) => {
  if (cmd === 'claude') return Promise.resolve(ok('A one-line recap.'));
  if (cmd !== 'gh') throw new Error(`unexpected process: ${cmd}`);

  if (args[0] === '--version') return Promise.resolve(ok('gh version 2.0.0'));
  if (args[0] === 'repo') return Promise.resolve(ok('{"nameWithOwner":"o/r"}'));
  if (args[0] === 'pr') return Promise.resolve(ok(PR_JSON));

  const jq = args[args.indexOf('--jq') + 1];
  switch (jq) {
    case '.login':
      return Promise.resolve(ok('caller-bot'));
    case '.data.repository.pullRequest.comments.nodes[]':
      return Promise.resolve(ok(COMMENTS));
    case '.data.repository.pullRequest.reviews.nodes[]':
      return Promise.resolve(ok(REVIEWS));
    case '.data.repository.pullRequest.reviewThreads.nodes // []':
      return Promise.resolve(ok(THREADS));
    case '.data.repository.pullRequest.reviewRequests.nodes // []':
      return Promise.resolve(ok('[]'));
    case '.check_runs // []':
      return Promise.resolve(ok('[]'));
    default:
      throw new Error(`unexpected gh --jq ${jq ?? '(none)'}`);
  }
};

describe('run (end to end wiring)', () => {
  it('emits a well-formed pr-status document from the forge reads', async () => {
    const out = collector();
    const err = collector();

    const code = await run(['7'], {
      stdout: out.stream,
      stderr: err.stream,
      env: {
        CLAUDE_PLUGIN_OPTION_OPERATOR_LOGIN: 'operator',
        CLAUDE_PROJECT_DIR: '/repo',
      },
      run: fakeRunner,
      fs: memoryFs(),
    });

    const xml = out.text();
    assert.equal(code, 0);
    assert.match(xml, /^<pr-status repo="o\/r" pr="7" head="feature">/u);
    assert.match(xml, /<terminal state="open"/u);
    assert.match(xml, /<checks state="passing">/u);
    assert.match(xml, /<merge-conflicts present="false"\/>/u);
    assert.match(
      xml,
      /<review author="copilot" mode="bot" state="commented"\/>/u
    );
    assert.match(xml, /<\/pr-status>$/mu);
  });

  it('classifies each comment and thread from actionability rules', async () => {
    const out = collector();
    const err = collector();

    await run(['7'], {
      stdout: out.stream,
      stderr: err.stream,
      env: {
        CLAUDE_PLUGIN_OPTION_OPERATOR_LOGIN: 'operator',
        CLAUDE_PROJECT_DIR: '/repo',
      },
      run: fakeRunner,
      fs: memoryFs(),
    });

    const xml = out.text();
    // A reviewer's comment is live work.
    assert.match(xml, /<comment id="C_1" actionable="true"/u);
    // The agent's own plan comment is a suppressed artifact.
    assert.match(
      xml,
      /<comment id="C_2" actionable="false" reason="agent-artifact"/u
    );
    // A platform-resolved thread is settled.
    assert.match(xml, /<thread id="T_1" actionable="false" reason="resolved"/u);
  });
});
