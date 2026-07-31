import {createHash} from 'node:crypto';
import {join} from 'node:path';

import type {FileSystem} from './fsx.mts';

/** Full hex sha256 of a body — used to detect a changed cached item. */
export function hashBody(body: string): string {
  return createHash('sha256').update(body).digest('hex');
}

/** A stable, content-derived id: the first 16 hex chars of the body's sha256. */
export function contentId(body: string): string {
  return hashBody(body).slice(0, 16);
}

/** A raw platform id reduced to a filesystem- and attribute-safe token. */
export function sanitizeId(rawId: string): string {
  return rawId.replaceAll(/[^A-Za-z0-9_=-]/gu, '_');
}

export interface CacheEntry {
  /** Absolute path of the cached body, emitted as the item's `cache=` attribute. */
  readonly cachePath: string;
  /** Absolute path of the lazily-generated recap. */
  readonly summaryPath: string;
}

/**
 * Write `<dir>/<sub>/<id>.md` when the body changed since last run, tracking a
 * sibling `.hash` so an unchanged body is not rewritten. A once-generated
 * summary is deliberately NOT deleted on change: it is a recap the agent reads
 * alongside the new content when a settled item later flips back to actionable.
 */
export async function cacheItem(
  fs: FileSystem,
  dir: string,
  sub: string,
  id: string,
  body: string
): Promise<CacheEntry> {
  const cachePath = join(dir, sub, `${id}.md`);
  const hashPath = join(dir, sub, `${id}.hash`);
  const summaryPath = join(dir, sub, `${id}.summary.md`);

  const newHash = hashBody(body);
  const oldHash = await fs.read(hashPath);
  if (oldHash !== newHash || !(await fs.exists(cachePath))) {
    await fs.write(cachePath, body);
    await fs.write(hashPath, newHash);
  }
  return {cachePath, summaryPath};
}
