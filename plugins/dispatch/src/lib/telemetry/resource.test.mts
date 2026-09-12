import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after, describe, it} from 'node:test';
import {pathToFileURL} from 'node:url';

import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';

import {pluginVersion, SERVICE_NAME, telemetryResource} from './resource.mts';

/** The manifest, reached independently of the path `resource.mts` uses. */
const MANIFEST = new URL(
  '../../../.claude-plugin/plugin.json',
  import.meta.url
);

async function declared(): Promise<string> {
  const {version} = JSON.parse(await readFile(MANIFEST, 'utf8')) as {
    version: string;
  };
  return version;
}

let scratch: string | undefined;

/** A manifest file holding exactly `body`. */
async function manifest(body: string): Promise<URL> {
  scratch ??= await mkdtemp(join(tmpdir(), 'dispatch-resource-'));
  const path = join(scratch, `${Math.random().toString(36).slice(2)}.json`);
  await writeFile(path, body);
  return pathToFileURL(path);
}

after(async () => {
  if (scratch) await rm(scratch, {recursive: true, force: true});
});

describe('pluginVersion', () => {
  it('reads the version the plugin manifest declares', async () => {
    // Compared against the file rather than against a shape, so that a broken
    // relative path — which is the thing most likely to break, since the
    // module sits at a different depth in a checkout and in the directory
    // Claude Code unpacks a plugin into — fails instead of passing as the
    // `0.0.0` fallback.
    assert.equal(await pluginVersion(), await declared());
  });

  it('reads a distinctive version out of a manifest', async () => {
    assert.equal(
      await pluginVersion(await manifest('{"version": "9.8.7-probe"}')),
      '9.8.7-probe'
    );
  });

  it('falls back to 0.0.0 when the manifest is not there', async () => {
    // semantic-release writes this file during a release, so a run that dies
    // in the middle can leave it missing. That is not worth failing a command
    // over.
    assert.equal(
      await pluginVersion(new URL('file:///nonexistent/plugin.json')),
      '0.0.0'
    );
  });

  it('falls back to 0.0.0 when the manifest is truncated', async () => {
    assert.equal(
      await pluginVersion(await manifest('{"version": "0.1')),
      '0.0.0'
    );
  });

  it('falls back to 0.0.0 when the version is not a string', async () => {
    assert.equal(
      await pluginVersion(await manifest('{"version": 3}')),
      '0.0.0'
    );
  });
});

describe('telemetryResource', () => {
  it('names the service and the version the manifest declares', async () => {
    const {attributes} = await telemetryResource();

    assert.deepEqual(
      {
        name: attributes[ATTR_SERVICE_NAME],
        version: attributes[ATTR_SERVICE_VERSION],
      },
      {name: SERVICE_NAME, version: await declared()}
    );
  });

  it('leaves the detected attributes to the SDK', async () => {
    // These are defaults for NodeSDK to merge its detectors over, not a
    // finished resource: one that already carried process.* and host.* would
    // be doing the detectors' job, and one that carried anything more under
    // service.name would stop OTEL_SERVICE_NAME from winning.
    assert.deepEqual(
      Object.keys((await telemetryResource()).attributes).sort(),
      [ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION]
    );
  });
});
