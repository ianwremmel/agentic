import {readFile} from 'node:fs/promises';

import {resourceFromAttributes} from '@opentelemetry/resources';
import type {Resource} from '@opentelemetry/resources';
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';

/** `service.name` for both processes: one service, two entry points. */
export const SERVICE_NAME = 'dispatch';

/** The plugin manifest, relative to this file in every layout it ships in. */
const MANIFEST = new URL(
  '../../../.claude-plugin/plugin.json',
  import.meta.url
);

/**
 * The version `plugin.json` declares, or `0.0.0` when it is missing, truncated,
 * or not a string — semantic-release writes this file, and a half-finished
 * release is not worth failing a command over. `serverInfo()` in
 * `lib/mcp/mcp.mts` reads it the same way.
 */
export async function readPluginVersion(
  manifest: URL = MANIFEST
): Promise<string> {
  try {
    const parsed = JSON.parse(await readFile(manifest, 'utf8')) as {
      version?: unknown;
    };
    return typeof parsed.version === 'string' ? parsed.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * The identity every record carries. Defaults only: `NodeSDK` merges its
 * detectors over this, so `OTEL_SERVICE_NAME` and `OTEL_RESOURCE_ATTRIBUTES` win.
 */
export async function buildResource(): Promise<Resource> {
  return resourceFromAttributes({
    [ATTR_SERVICE_NAME]: SERVICE_NAME,
    [ATTR_SERVICE_VERSION]: await readPluginVersion(),
  });
}
