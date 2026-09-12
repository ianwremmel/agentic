import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {readFile, readdir} from 'node:fs/promises';
import {join} from 'node:path';
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

  it('ships npm-shrinkwrap.json, the only lockfile that can reach an install', async () => {
    // An install resolves a plugin's dependencies from the plugin directory
    // itself, and npm never publishes package-lock.json, so this is the only
    // lockfile that can get there. Without it the tree is resolved fresh.
    assert.ok((await packedPaths()).has('npm-shrinkwrap.json'));
  });

  it('locks the dependencies the manifest declares, at a resolved version', async () => {
    const manifest = await readJson<{dependencies?: Record<string, string>}>(
      'package.json'
    );
    const lock = await readJson<Lockfile>('npm-shrinkwrap.json');
    // The checkout npm actually installs from. A shrinkwrap regenerated against
    // a different registry state resolves differently from what is being run
    // and tested here, and nothing else would notice.
    const root = await readJson<Lockfile>('../../package-lock.json');

    // A shrinkwrap left behind by an edit to `dependencies` installs a tree
    // that no longer matches the code, and `npm ci` fails the install outright
    // when the two disagree on the root.
    assert.deepEqual(
      lock.packages?.['']?.dependencies ?? {},
      manifest.dependencies ?? {}
    );
    for (const name of Object.keys(manifest.dependencies ?? {})) {
      const locked = lock.packages?.[`node_modules/${name}`]?.version;
      assert.ok(
        locked,
        `${name} is declared but not locked; regenerate npm-shrinkwrap.json`
      );
      assert.equal(
        locked,
        root.packages?.[`node_modules/${name}`]?.version,
        `${name} is locked at a different version than the workspace installs`
      );
    }
  });
});

interface Lockfile {
  readonly packages?: Record<
    string,
    {
      readonly version?: string;
      readonly dependencies?: Record<string, string>;
    }
  >;
}

async function readJson<T>(name: string): Promise<T> {
  return JSON.parse(await readFile(join(PLUGIN_ROOT, name), 'utf8')) as T;
}
