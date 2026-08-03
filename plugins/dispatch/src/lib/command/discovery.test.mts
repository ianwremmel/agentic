import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe, it} from 'node:test';

import {discover} from './discovery.mts';
import {DefinitionError} from '../errors/index.mts';

const GOOD = new URL('./__fixtures__/commands/', import.meta.url);
const BAD_NAME = new URL('./__fixtures__/bad-name/', import.meta.url);
const BAD_EXPORT = new URL('./__fixtures__/bad-export/', import.meta.url);

// A colocated `*.test.mts` fixture cannot live under the real fixtures tree:
// the test runner globs `plugins/**/*.test.mts` and would execute it. Building
// the tree in a temp dir keeps the skip-filter honest without that collision.
const BARREL = new URL('./index.mts', import.meta.url).href;

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

  it('loads command modules but skips colocated *.test.mts files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dispatch-discover-'));
    try {
      await writeFile(
        join(dir, 'keep.mts'),
        `import {AbstractCommand} from ${JSON.stringify(BARREL)};\n` +
          `export class Command extends AbstractCommand {\n` +
          `  name = 'keep';\n  summary = 's';\n  env = [];\n  options = {};\n` +
          `  async run() {}\n}\n`
      );
      await writeFile(
        join(dir, 'keep.test.mts'),
        `export const skipped = true;\n`
      );

      const root = await discover(dir);

      assert.equal(root.children.get('keep')?.command?.name, 'keep');
      // The .test.mts sibling was never imported: no `keep.test` node, and its
      // lack of a Command export did not raise a DefinitionError.
      assert.equal(root.children.has('keep.test'), false);
      assert.equal(root.children.size, 1);
    } finally {
      await rm(dir, {recursive: true, force: true});
    }
  });
});
