import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import {isBuiltin} from 'node:module';
import {tmpdir} from 'node:os';
import {isAbsolute, join, relative, sep} from 'node:path';
import {after, describe, it} from 'node:test';
import {promisify} from 'node:util';
import ts from 'typescript';

const execFileAsync = promisify(execFile);

const PLUGIN_ROOT = import.meta.dirname;
const REPO_ROOT = join(PLUGIN_ROOT, '..', '..');

/** Present in a working tree, never part of the published tree. */
const NOT_SHIPPED = new Set(['node_modules', 'coverage']);

/** Shipped files whose imports have to resolve wherever the plugin lands. */
const CODE = /\.m?[jt]s$/u;

/** `data:`, `file:`, `https:` — resolved by the loader, never by npm. */
const URL_SPECIFIER = /^[A-Za-z][A-Za-z\d+.-]*:/u;

/**
 * Claude Code gives a plugin's dependency install this long before treating it
 * as failed, so an install that does not fit has the same effect as no
 * lockfile at all: the plugin loads and its imports do not resolve.
 */
const INSTALL_BUDGET_MS = 60_000;

const CHILD = {timeout: INSTALL_BUDGET_MS} as const;

interface Manifest {
  dependencies?: Record<string, string>;
  name?: string;
  version?: string;
}

let pack: Promise<string[]> | undefined;

/** Every path in the tarball `package.json` `files` would produce. */
async function packedFiles(): Promise<string[]> {
  pack ??= (async () => {
    const {stdout} = await execFileAsync(
      'npm',
      ['pack', '--dry-run', '--json'],
      {cwd: PLUGIN_ROOT, ...CHILD}
    );
    const [report] = JSON.parse(stdout) as {files?: {path: string}[]}[];
    const files = report?.files;
    assert.ok(files, '`npm pack --dry-run --json` reported no files');
    return files.map(({path}) => path);
  })();
  return pack;
}

async function packedPaths(): Promise<Set<string>> {
  return new Set((await packedFiles()).map((path) => path.split('/')[0] ?? ''));
}

async function manifest(): Promise<Manifest> {
  return JSON.parse(
    await readFile(join(PLUGIN_ROOT, 'package.json'), 'utf8')
  ) as Manifest;
}

/**
 * Bare specifiers the shipped code imports, mapped to the files importing
 * them. Read with TypeScript's own scanner so a specifier in a comment, a
 * string, or a template literal is not mistaken for an import — the cost of a
 * false positive here is a demand for a dependency nothing needs. A property
 * call (`obj.require('x')`) is the one shape it still reports; the CLI is ESM
 * and has none.
 */
async function shippedImports(): Promise<Map<string, string[]>> {
  const found = new Map<string, string[]>();
  for (const path of (await packedFiles()).filter((p) => CODE.test(p))) {
    const source = await readFile(join(PLUGIN_ROOT, path), 'utf8');
    for (const {fileName} of ts.preProcessFile(source, true, true)
      .importedFiles) {
      if (fileName.startsWith('.') || fileName.startsWith('/')) continue;
      if (isBuiltin(fileName) || URL_SPECIFIER.test(fileName)) continue;
      found.set(fileName, [...(found.get(fileName) ?? []), path]);
    }
  }
  return found;
}

/** The package a specifier belongs to: `@scope/name/sub` -> `@scope/name`. */
function packageOf(specifier: string): string {
  const segments = specifier.split('/');
  return specifier.startsWith('@')
    ? segments.slice(0, 2).join('/')
    : (segments[0] ?? '');
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

  it('ships npm-shrinkwrap.json, which a "files" list has to name explicitly', async () => {
    // Claude Code installs a plugin's dependencies only when its root holds
    // both a package.json and a lockfile. Without one it skips the install,
    // not the plugin: the plugin loads and every bare import fails at first
    // use, with nothing said about why. npm never publishes
    // package-lock.json, so the shrinkwrap is the only lockfile that can
    // reach an install.
    assert.ok((await packedPaths()).has('npm-shrinkwrap.json'));
  });
});

describe('declared dependencies', () => {
  it('cover every bare specifier the shipped code imports', async () => {
    // Nothing in this checkout makes an undeclared bare import fail. The repo
    // root is an npm workspace with no plugins/dispatch/node_modules, so
    // Node's upward walk reaches the root's node_modules and resolves whatever
    // the toolchain installed — a resolution no install of the plugin
    // reproduces. The install test below is the other half: this one catches a
    // dependency dropped while code still imports it, that one catches a
    // declaration that cannot install.
    const declared = new Set(
      Object.keys((await manifest()).dependencies ?? {})
    );
    const undeclared = [...(await shippedImports())]
      .filter(([specifier]) => !declared.has(packageOf(specifier)))
      .map(([specifier, paths]) => `${specifier} (${paths.join(', ')})`);

    assert.deepEqual(
      undeclared,
      [],
      'add these to plugins/dispatch/package.json "dependencies"'
    );
  });

  it('match the shipped lockfile', async () => {
    // `npm ci` refuses to run when the two disagree, and Claude Code treats a
    // refused install the way it treats no lockfile: the plugin loads anyway
    // and every bare import fails at first use. The root CLAUDE.md carries the
    // regeneration command — it has to run outside the workspace, or npm
    // rewrites the root lockfile and leaves this one untouched.
    //
    // The dependency map and the name are the whole comparison. The version is
    // left out on purpose: semantic-release writes the next number into
    // package.json and plugin.json and commits only those two, so the
    // shrinkwrap's copy goes stale on every release. Neither `npm ci` nor
    // `npm publish` cares — a root version that disagrees installs and packs
    // exactly the same — so asserting it here would turn every release commit
    // into a red build on main and teach nothing about what installs.
    const {dependencies, name} = await manifest();
    const lock = JSON.parse(
      await readFile(join(PLUGIN_ROOT, 'npm-shrinkwrap.json'), 'utf8')
    ) as {name?: string; packages?: Record<string, Manifest>};

    assert.deepEqual(
      {
        dependencies: lock.packages?.['']?.dependencies,
        name: lock.name,
      },
      {dependencies, name},
      'npm-shrinkwrap.json is stale'
    );
  });

  it('lock at the versions the workspace installs', async () => {
    // The two lockfiles resolve independently: the tests run against the root
    // package-lock's tree, users get the shrinkwrap's. A shrinkwrap
    // regenerated against a later registry state installs a version nothing
    // here was ever run against, and every other check still passes — the
    // manifests agree, `npm ci` succeeds, the imports resolve.
    const {dependencies} = await manifest();
    const read = async (path: string) =>
      JSON.parse(await readFile(path, 'utf8')) as {
        packages?: Record<string, Manifest>;
      };
    const lock = await read(join(PLUGIN_ROOT, 'npm-shrinkwrap.json'));
    const root = await read(join(REPO_ROOT, 'package-lock.json'));

    for (const name of Object.keys(dependencies ?? {})) {
      const at = `node_modules/${name}`;
      assert.equal(
        lock.packages?.[at]?.version,
        root.packages?.[at]?.version,
        `${name} is locked at a different version than the workspace installs`
      );
    }
  });
});

describe('installed plugin', () => {
  let cache: string | undefined;

  after(async () => {
    if (cache) await rm(cache, {recursive: true, force: true});
  });

  it('resolves its dependencies and runs from the install layout', async () => {
    const {dependencies, version} = await manifest();
    const required = [
      ...new Set([
        ...Object.keys(dependencies ?? {}),
        ...(await shippedImports()).keys(),
      ]),
    ];
    assert.ok(required.length > 0, 'expected the plugin to need a dependency');

    cache = await mkdtemp(join(tmpdir(), 'dispatch-install-'));
    // Resolution from anywhere inside the repo reaches the root node_modules
    // by Node's upward walk and would prove nothing. Compare real paths: a
    // TMPDIR symlinked into the repo defeats a comparison of spellings.
    const outside = relative(await realpath(REPO_ROOT), await realpath(cache));
    assert.ok(
      isAbsolute(outside) || outside === '..' || outside.startsWith(`..${sep}`),
      `${cache} is inside the repo; resolution there proves nothing`
    );

    // Claude Code unpacks a plugin into
    // <cache>/<marketplace>/<plugin>/<version>/ and installs there. The
    // directory matters: Node refuses to strip types from a .mts file under
    // any node_modules, so the CLI can only run from a plain directory with
    // its dependencies installed beneath it.
    const root = join(cache, 'agentic', 'dispatch', version ?? '0.0.0');
    await mkdir(root, {recursive: true});
    const {stdout} = await execFileAsync(
      'npm',
      ['pack', '--json', '--pack-destination', cache],
      {cwd: PLUGIN_ROOT, ...CHILD}
    );
    const [packed] = JSON.parse(stdout) as {filename?: string}[];
    const tarball = packed?.filename;
    assert.ok(tarball, '`npm pack --json` reported no tarball');
    await execFileAsync(
      'tar',
      ['-xzf', join(cache, tarball), '-C', root, '--strip-components=1'],
      CHILD
    );

    // The command Claude Code runs, under the budget it allows. `npm ci` pins
    // to the shipped shrinkwrap, so what installs here is what installs for a
    // user rather than whatever the caret ranges resolve to today.
    await execFileAsync(
      'npm',
      ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--prefer-offline'],
      {cwd: root, ...CHILD}
    );

    // A source file of the plugin, in the layout it is installed into,
    // importing what it declares. Under `src/` because that is where the
    // shipped code that will import these lives, so the probe resolves from
    // the same directory depth it will. Running the CLI is not a substitute:
    // it touches no dependency until something imports one.
    const probe = join(root, 'src', 'dependency-probe.mts');
    await writeFile(
      probe,
      `${required
        .map((specifier) => `import ${JSON.stringify(specifier)};`)
        .join('\n')}\nprocess.stderr.write('resolved');\n`
    );
    const {stderr} = await execFileAsync(process.execPath, [probe], CHILD);
    assert.equal(stderr, 'resolved');

    // And the CLI itself still starts once node_modules sits beside it.
    const greet = await execFileAsync(
      join(root, 'bin', 'dispatch'),
      ['greet', 'World'],
      CHILD
    );
    assert.equal(greet.stdout.trim(), 'hello World');
  });
});
