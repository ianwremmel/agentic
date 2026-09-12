/**
 * Write a version into a Claude Code `plugin.json`. Run from
 * semantic-release's `prepare` step, alongside `@semantic-release/npm`'s write
 * to the sibling `package.json`, so a published plugin's two manifests always
 * carry the same number.
 *
 *   node scripts/set-plugin-version.mts 1.4.0 plugins/dispatch/.claude-plugin/plugin.json
 *
 * The edit is a substitution on the existing `"version"` value rather than a
 * parse-and-reserialize, so escapes and formatting elsewhere in the manifest
 * survive untouched and the diff is one line.
 */

import {deepStrictEqual} from 'node:assert/strict';
import {readFile, writeFile} from 'node:fs/promises';
import process from 'node:process';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';

/** https://semver.org/#is-there-a-suggested-regular-expression-regex-to-check-a-semver-string */
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

/**
 * Deliberately unanchored, and `\s` rather than `[ \t]` so a key split across
 * lines still counts. Both looseness directions are safe here because more
 * matches mean the manifest is rejected as ambiguous; missing one is what
 * would let the wrong field be rewritten.
 *
 * Both quotes around the literal `"version"` earn their place, for different
 * reasons. The trailing one excludes a `"version"` written inside a string
 * value: JSON escapes those quotes, so such a key reads `\"version\"` in the
 * raw text and where the pattern wants its closing quote there is a
 * backslash. The leading one excludes a sibling key that merely ends in the
 * word, like `"api_version"`. Dropping either turns a real manifest into a
 * failed release, so keep both when editing this.
 */
const VERSION_VALUE = /("version"\s*:\s*")([^"]*)(")/g;

/**
 * Replace a manifest's top-level version string.
 *
 * Throws unless the source is a JSON object carrying a `version` string and
 * the text contains exactly one `"version"` key. More than one is ambiguity,
 * not a nuisance: picking either would risk writing the version into a nested
 * object and leaving the real one stale. The result is then parsed back, and
 * both that its version is now the requested one and that no other field
 * moved are asserted — JSON keeps the *last* of two duplicate keys, so
 * checking only that nothing else changed would pass a substitution that hit
 * a shadowed key and left the effective version untouched.
 */
export function setVersion(source: string, version: string): string {
  if (!SEMVER.test(version)) {
    throw new Error(`not a semantic version: ${JSON.stringify(version)}`);
  }

  const before: unknown = JSON.parse(source);
  if (
    typeof before !== 'object' ||
    before === null ||
    !('version' in before) ||
    typeof before.version !== 'string'
  ) {
    throw new Error('no top-level "version" string');
  }

  const matches = source.match(VERSION_VALUE);
  if (matches?.length !== 1) {
    const found = String(matches?.length ?? 0);
    throw new Error(`expected exactly one "version" key, found ${found}`);
  }

  const result = source.replace(VERSION_VALUE, `$1${version}$3`);

  const after: unknown = JSON.parse(result);
  const wrote = (after as {version?: unknown}).version;
  if (wrote !== version) {
    throw new Error(
      `the substitution left the top-level "version" as ${JSON.stringify(wrote)}`
    );
  }
  deepStrictEqual(
    {...(after as object), version: before.version},
    before,
    'the substitution changed something other than the top-level "version"'
  );

  return result;
}

async function main(): Promise<void> {
  const {positionals} = parseArgs({allowPositionals: true});
  const [version, ...files] = positionals;

  if (!version || files.length === 0) {
    throw new Error('usage: set-plugin-version <version> <plugin.json...>');
  }

  // Read and rewrite every manifest before writing any of them. Writing as
  // each one validates would leave the earlier files bumped and the rest
  // stale when a later one turns out to be unreadable or ambiguous — the
  // mismatch this script exists to prevent.
  const rewritten = await Promise.all(
    files.map(async (file) => {
      try {
        const source = await readFile(file, 'utf8');
        return {file, contents: setVersion(source, version)};
      } catch (error) {
        // Which file failed is the whole diagnostic when several are named.
        throw new Error(`${file}: ${(error as Error).message}`, {cause: error});
      }
    })
  );

  for (const {file, contents} of rewritten) {
    await writeFile(file, contents);
    process.stdout.write(`${file}: version ${version}\n`);
  }
}

const invokedDirectly =
  typeof process.argv[1] === 'string' &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`set-plugin-version: ${(error as Error).message}\n`);
    process.exitCode = 1;
  }
}
