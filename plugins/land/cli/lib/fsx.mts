import {mkdir, readFile, stat, writeFile} from 'node:fs/promises';

/**
 * The filesystem surface pr-status needs for its per-PR cache. Injected so the
 * item emitters can be exercised against an in-memory fake with no disk.
 */
export interface FileSystem {
  /** Create a directory and any missing parents. */
  mkdirp(path: string): Promise<void>;
  /** Read a file as UTF-8, or `undefined` when it does not exist. */
  read(path: string): Promise<string | undefined>;
  /** Write a file, creating or truncating it. */
  write(path: string, data: string): Promise<void>;
  /** Whether a path exists. */
  exists(path: string): Promise<boolean>;
}

/** The production {@link FileSystem}, over node:fs/promises. */
export const nodeFs: FileSystem = {
  async mkdirp(path) {
    await mkdir(path, {recursive: true});
  },
  async read(path) {
    try {
      return await readFile(path, 'utf8');
    } catch (cause) {
      if (isNotFound(cause)) return undefined;
      throw cause;
    }
  },
  async write(path, data) {
    await writeFile(path, data);
  },
  async exists(path) {
    try {
      await stat(path);
      return true;
    } catch (cause) {
      if (isNotFound(cause)) return false;
      throw cause;
    }
  },
};

function isNotFound(cause: unknown): boolean {
  return (
    typeof cause === 'object' &&
    cause !== null &&
    'code' in cause &&
    (cause as {code?: unknown}).code === 'ENOENT'
  );
}
