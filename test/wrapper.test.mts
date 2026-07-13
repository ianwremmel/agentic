import assert from 'node:assert/strict';
import path from 'node:path';
import {describe, it} from 'node:test';

import {fakeNodeDir, pathWithoutNode, runDispatch} from './helpers/cli.mts';

describe('bin/dispatch node preflight', () => {
  it('runs the CLI when node is new enough', async () => {
    const {code, stdout} = await runDispatch(['greet', 'World']);

    assert.equal(code, 0);
    assert.equal(stdout, 'hello World\n');
  });

  it('refuses a node older than the minimum, naming the version it found', async () => {
    const dir = await fakeNodeDir('v20.11.0');

    const {code, stdout, stderr} = await runDispatch(['greet', 'World'], {
      env: {PATH: `${dir}${path.delimiter}${process.env.PATH ?? ''}`},
    });

    assert.equal(stdout, '', 'a rejected node must not produce a greeting');
    assert.notEqual(code, 0);
    assert.match(stderr, /^error: node 20\.11\.0 .* is too old/mu);
    assert.match(stderr, /22\.18\.0/u, 'the message states the minimum');
  });

  it('accepts a node at exactly the minimum version', async () => {
    // The fake echoes its version whatever the arguments, so seeing that echo on
    // stdout proves the gate let 22.18.0 through and the wrapper exec'd it.
    const dir = await fakeNodeDir('v22.18.0');

    const {code, stdout, stderr} = await runDispatch(['greet', 'World'], {
      env: {PATH: `${dir}${path.delimiter}${process.env.PATH ?? ''}`},
    });

    assert.doesNotMatch(stderr, /too old/u);
    assert.match(stdout, /^v22\.18\.0$/mu);
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
      /node not found \(looked for '\/nonexistent\/node'\)/u,
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
      /^ts=\S+ level=debug component=dispatch-wrapper msg="node resolved" node_bin=\S+ node_version=\S+/mu,
    );
  });
});
