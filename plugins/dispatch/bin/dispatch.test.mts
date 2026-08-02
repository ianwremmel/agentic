import assert from 'node:assert/strict';
import path from 'node:path';
import {describe, it} from 'node:test';

import {fakeNodeDir, pathWithoutNode, runDispatch} from '../test-harness.mts';

describe('bin/dispatch node preflight', () => {
  it('runs the CLI when node is new enough', async () => {
    const {code, stdout} = await runDispatch(['greet', 'World']);

    assert.equal(code, 0);
    assert.equal(stdout, 'hello World\n');
  });

  it('honors DISPATCH_ENTRY, running an alternate entry point through the same wrapper', async () => {
    // .mcp.json points the MCP server here so its spawn goes through the same
    // node floor check as the legacy `cli/` tree, rather than a second,
    // unchecked entry path. `mcp` exists only as a command in `src/commands`,
    // not in the legacy `cli/commands` tree, so it distinguishes which tree
    // actually ran rather than asserting on output the two trees share.
    const entry = path.join(import.meta.dirname, '..', 'src', 'main.mts');

    const legacy = await runDispatch(['mcp'], {input: ''});
    assert.notEqual(legacy.code, 0, 'the legacy tree has no `mcp` command');

    const {code, stderr} = await runDispatch(['mcp'], {
      env: {DISPATCH_ENTRY: entry},
      input: '',
    });

    assert.equal(code, 0, stderr);
  });

  it('still enforces the node floor when DISPATCH_ENTRY points elsewhere', async () => {
    const dir = await fakeNodeDir('v20.11.0');
    const entry = path.join(import.meta.dirname, '..', 'src', 'main.mts');

    const {code, stdout, stderr} = await runDispatch(['greet', 'World'], {
      env: {
        PATH: `${dir}${path.delimiter}${process.env.PATH ?? ''}`,
        DISPATCH_ENTRY: entry,
      },
    });

    assert.equal(
      stdout,
      '',
      'a rejected node must not run the alternate entry'
    );
    assert.notEqual(code, 0);
    assert.match(stderr, /too old/u);
  });

  it('refuses a node older than the minimum, naming the version it found', async () => {
    const dir = await fakeNodeDir('v20.11.0');

    const {code, stdout, stderr} = await runDispatch(['greet', 'World'], {
      env: {PATH: `${dir}${path.delimiter}${process.env.PATH ?? ''}`},
    });

    assert.equal(stdout, '', 'a rejected node must not produce a greeting');
    assert.notEqual(code, 0);
    assert.match(stderr, /^error: node v20\.11\.0 .* is too old/mu);
    assert.match(stderr, /24\.18\.0/u, 'the message states the minimum');
  });

  it('refuses a prerelease of the minimum version', async () => {
    // 24.18.0-rc.1 predates the 24.18.0 release, so its type stripping is not
    // the release behavior the CLI is built against.
    const dir = await fakeNodeDir('v24.18.0-rc.1');

    const {code, stdout, stderr} = await runDispatch(['greet', 'World'], {
      env: {PATH: `${dir}${path.delimiter}${process.env.PATH ?? ''}`},
    });

    assert.equal(stdout, '');
    assert.notEqual(code, 0);
    assert.match(stderr, /^error: node v24\.18\.0-rc\.1 .* is too old/mu);
  });

  it('accepts a prerelease above the minimum version', async () => {
    const dir = await fakeNodeDir('v25.0.0-nightly20260101');

    const {stdout, stderr} = await runDispatch(['greet', 'World'], {
      env: {PATH: `${dir}${path.delimiter}${process.env.PATH ?? ''}`},
    });

    assert.doesNotMatch(stderr, /too old/u);
    assert.match(stdout, /^v25\.0\.0-nightly20260101$/mu);
  });

  it('accepts a node at exactly the minimum version', async () => {
    // The fake echoes its version whatever the arguments, so seeing that echo on
    // stdout proves the gate let 24.18.0 through and the wrapper exec'd it.
    const dir = await fakeNodeDir('v24.18.0');

    const {code, stdout, stderr} = await runDispatch(['greet', 'World'], {
      env: {PATH: `${dir}${path.delimiter}${process.env.PATH ?? ''}`},
    });

    assert.doesNotMatch(stderr, /too old/u);
    assert.match(stdout, /^v24\.18\.0$/mu);
    assert.equal(code, 0);
  });

  it('reports a missing node with an actionable message and exit 127', async () => {
    const {code, stderr} = await runDispatch(['greet', 'World'], {
      env: {PATH: await pathWithoutNode()},
    });

    assert.equal(code, 127);
    assert.match(stderr, /^error: node not found/mu);
    assert.match(stderr, /nodejs\.org/u);
  });

  it('honors DISPATCH_NODE when it points at a usable node', async () => {
    const {code, stdout} = await runDispatch(['greet', 'World'], {
      env: {DISPATCH_NODE: process.execPath},
    });

    assert.equal(code, 0);
    assert.equal(stdout, 'hello World\n');
  });

  it('reports a DISPATCH_NODE that does not exist', async () => {
    const {code, stderr} = await runDispatch(['greet', 'World'], {
      env: {DISPATCH_NODE: '/nonexistent/node'},
    });

    assert.equal(code, 127);
    assert.match(
      stderr,
      /node not found \(looked for '\/nonexistent\/node'\)/u
    );
  });

  it('logs its own preflight in logfmt only at debug level', async () => {
    const quiet = await runDispatch(['greet', 'World']);
    assert.doesNotMatch(quiet.stderr, /component=dispatch-wrapper/u);

    const verbose = await runDispatch(['greet', 'World'], {
      env: {DISPATCH_LOG_LEVEL: 'debug'},
    });
    assert.match(
      verbose.stderr,
      /^ts=\S+ level=debug component=dispatch-wrapper msg="node resolved" node_bin=\S+ node_version=\S+/mu
    );
  });
});
