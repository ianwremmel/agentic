import assert from 'node:assert/strict';
import {mkdtemp, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {describe, it} from 'node:test';

import {DataError, EXIT_DATA} from './errors.mts';
import {pluginVersion} from './plugin-version.mts';

/** A manifest file holding `content`, addressed the way the reader takes it. */
async function manifest(content: string): Promise<URL> {
  const dir = await mkdtemp(path.join(tmpdir(), 'dispatch-manifest-'));
  const file = path.join(dir, 'plugin.json');
  await writeFile(file, content, 'utf8');
  return new URL(`file://${file}`);
}

describe('pluginVersion', () => {
  it('resolves the manifest relative to the installed plugin', async () => {
    // The path is the thing under test: the plugin is copied into a cache on
    // install, so a version read that depended on the working directory would
    // fail there and nowhere else.
    assert.match(await pluginVersion(), /^\d+\.\d+\.\d+/u);
  });

  it('reports an unreadable manifest as bad data, with a hint', async () => {
    const missing = new URL('file:///nonexistent/plugin.json');

    await assert.rejects(pluginVersion(missing), (error: unknown) => {
      assert.ok(error instanceof DataError);
      assert.match(error.message, /cannot read the plugin manifest/u);
      assert.equal(error.exitCode, EXIT_DATA);
      assert.match(error.hint ?? '', /reinstall/u);
      return true;
    });
  });

  it('reports a manifest with no usable version', async () => {
    for (const content of ['{}', '{"version": ""}', '{"version": 3}']) {
      await assert.rejects(
        pluginVersion(await manifest(content)),
        /declares no version/u,
        content
      );
    }
  });
});
