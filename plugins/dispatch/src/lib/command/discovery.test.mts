import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {discover} from './discovery.mts';
import {DefinitionError} from '../errors/index.mts';

const GOOD = new URL('./__fixtures__/commands/', import.meta.url);
const BAD_NAME = new URL('./__fixtures__/bad-name/', import.meta.url);
const BAD_EXPORT = new URL('./__fixtures__/bad-export/', import.meta.url);

describe('discover', () => {
  it('builds a tree keyed by folder path', async () => {
    const root = await discover(GOOD);
    assert.equal(root.children.get('greet')?.command?.name, 'greet');
    assert.equal(
      root.children.get('math')?.children.get('add')?.command?.name,
      'add'
    );
    // `math` is a namespace-only node: no math.mts, so no command of its own.
    assert.equal(root.children.get('math')?.command, undefined);
  });

  it('lets a folder be both a runnable command and a namespace', async () => {
    const root = await discover(GOOD);
    const store = root.children.get('store');
    assert.equal(store?.command?.name, 'store');
    assert.equal(store.children.get('get')?.command?.name, 'get');
  });

  it('throws DefinitionError when a command name does not match its file', async () => {
    await assert.rejects(discover(BAD_NAME), DefinitionError);
  });

  it('throws DefinitionError when a file has no Command export', async () => {
    await assert.rejects(discover(BAD_EXPORT), DefinitionError);
  });
});
