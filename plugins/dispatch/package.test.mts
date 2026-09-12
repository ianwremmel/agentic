import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {readdir} from 'node:fs/promises';
import {describe, it} from 'node:test';
import {promisify} from 'node:util';

const execFileAsync = promisify(execFile);

const PLUGIN_ROOT = import.meta.dirname;

/** Present in a working tree, never part of the published tree. */
const NOT_SHIPPED = new Set(['node_modules', 'coverage']);

let pack: Promise<Set<string>> | undefined;

/** Top-level paths in the tarball `package.json` `files` would produce. */
async function packedPaths(): Promise<Set<string>> {
  pack ??= (async () => {
    const {stdout} = await execFileAsync(
      'npm',
      ['pack', '--dry-run', '--json'],
      {
        cwd: PLUGIN_ROOT,
      }
    );
    const [report] = JSON.parse(stdout) as {files?: {path: string}[]}[];
    const files = report?.files;
    assert.ok(files, '`npm pack --dry-run --json` reported no files');
    return new Set(files.map(({path}) => path.split('/')[0] ?? ''));
  })();
  return pack;
}

describe('published package', () => {
  it('ships every top-level directory of the plugin', async () => {
    const packed = await packedPaths();
    const directories = (await readdir(PLUGIN_ROOT, {withFileTypes: true}))
      .filter((entry) => entry.isDirectory() && !NOT_SHIPPED.has(entry.name))
      .map((entry) => entry.name);

    assert.ok(
      directories.length > 0,
      'expected the plugin to have directories'
    );
    // A directory in the marketplace checkout but not in the tarball reads as
    // a half-written install to anything that verifies the two against each
    // other by top-level directory name — the homelab agent-base bootstrap's
    // check_plugin_payloads() does, and flags the plugin as incomplete.
    for (const directory of directories) {
      assert.ok(
        packed.has(directory),
        `${directory}/ is missing from package.json "files"`
      );
    }
  });

  it('ships .mcp.json, which a "files" list has to name explicitly', async () => {
    // Without it the plugin loads but its MCP server never starts.
    assert.ok((await packedPaths()).has('.mcp.json'));
  });
});
