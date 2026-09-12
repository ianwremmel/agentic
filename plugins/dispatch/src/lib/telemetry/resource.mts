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
 * The version `plugin.json` declares, or `0.0.0` when it cannot be read.
 *
 * An unreadable manifest is not worth failing a command over, and it is not
 * hypothetical: semantic-release writes this file, so a half-finished release
 * can leave it missing or truncated. `serverInfo()` in `lib/mcp/mcp.mts` reads
 * the same file the same way for the MCP handshake.
 */
export async function pluginVersion(manifest: URL = MANIFEST): Promise<string> {
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
 * The identity every span, metric, and log record carries.
 *
 * These are defaults rather than the final word: `NodeSDK` merges its resource
 * detectors over this one, so `OTEL_SERVICE_NAME` and `OTEL_RESOURCE_ATTRIBUTES`
 * still win, and `process.*` and `host.*` are filled in by detection.
 */
export async function telemetryResource(): Promise<Resource> {
  return resourceFromAttributes({
    [ATTR_SERVICE_NAME]: SERVICE_NAME,
    [ATTR_SERVICE_VERSION]: await pluginVersion(),
  });
}
