import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {pluginVersion} from './plugin-version.mts';

describe('pluginVersion', () => {
  it('resolves the manifest relative to the installed plugin', async () => {
    // The path is the thing under test: the plugin is copied into a cache on
    // install, so a version read that depended on the working directory would
    // fail there and nowhere else.
    assert.match(await pluginVersion(), /^\d+\.\d+\.\d+/u);
  });
});
