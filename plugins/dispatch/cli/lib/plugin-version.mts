import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

import {DataError} from './errors.mts';

/**
 * The plugin manifest, resolved from this module rather than the working
 * directory: the plugin is copied into a cache on install, and the CLI is run
 * from wherever the session happens to be.
 */
const MANIFEST = new URL('../../.claude-plugin/plugin.json', import.meta.url);

/**
 * The installed plugin's version, read from its manifest so nothing has to be
 * kept in step with it by hand. Callers report it to a peer (MCP `serverInfo`),
 * which is why an unreadable manifest is a failure rather than a guess.
 *
 * `manifestUrl` exists so a test can point at a broken manifest; production
 * callers take the default.
 */
export async function pluginVersion(
  manifestUrl: URL = MANIFEST
): Promise<string> {
  let manifest: unknown;
  try {
    manifest = JSON.parse(await readFile(manifestUrl, 'utf8'));
  } catch (error) {
    throw new DataError('cannot read the plugin manifest', {
      cause: error,
      details: {path: fileURLToPath(manifestUrl)},
      hint: 'reinstall the dispatch plugin — its manifest is missing or is not JSON.',
    });
  }

  const version =
    typeof manifest === 'object' && manifest !== null && 'version' in manifest
      ? manifest.version
      : undefined;

  if (typeof version !== 'string' || version === '') {
    throw new DataError('the plugin manifest declares no version', {
      details: {path: fileURLToPath(manifestUrl)},
      hint: 'set a semver "version" in the plugin manifest.',
    });
  }

  return version;
}
