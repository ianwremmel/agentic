// §2.2.2 §Cache layout — on-disk cache for `dispatch pr-status`.
//
// Layout:
//   <root>/pr-status/<skill>/<repo-slug>/<pr-number>/
//     status.xml                         (most recent emitted output)
//     comments/<id>.md
//     comments/<id>.summary.md
//     threads/<id>.md
//     threads/<id>.summary.md
//     annotations/<id>.md
//     annotations/<id>.summary.md
//     annotations/<id>.ack
//
// <root> is the dispatch state directory from `paths.mts`. <skill> is the
// invoking skill's name. <repo-slug> is `<owner>__<repo>` with `/` → `__`
// and other unsafe characters encoded.

import {
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  existsSync,
  rmSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";

import {
  layoutForRoot,
  resolveStateRoot,
  type ResolveOptions,
} from "./paths.mts";

export interface CacheTarget {
  /** Owner/repo as `<owner>/<repo>`. */
  repo: string;
  pr: number;
  /** Skill namespace (concurrent skills must use distinct names). */
  skill: string;
}

export interface PrStatusCache {
  /** Absolute path to the PR's cache directory. */
  prDir(target: CacheTarget): string;
  /** Read the most recently written `status.xml`, or `undefined` if absent. */
  read(target: CacheTarget): string | undefined;
  /**
   * Write `status.xml`. Creates parent directories lazily. The file is
   * written via a temp + rename so concurrent readers never see a
   * partially-written XML.
   */
  write(target: CacheTarget, xml: string): void;
  /** Create the `annotations/<id>.ack` marker file. Empty contents. */
  writeAck(target: CacheTarget, annotationId: string): void;
  /** True iff the `.ack` marker for this annotation exists. */
  hasAck(target: CacheTarget, annotationId: string): boolean;
  /** Set of annotation IDs that currently have a `.ack` marker. */
  listAcks(target: CacheTarget): Set<string>;
  /**
   * Remove the entire `<prDir>` for one PR. Used when the task is
   * removed via `dispatch tasks remove` (wired up in a later ticket).
   */
  remove(target: CacheTarget): void;
}

/** Build a cache instance rooted at the resolved dispatch state directory. */
export function openPrStatusCache(opts: ResolveOptions = {}): PrStatusCache {
  const root = resolveStateRoot(opts);
  return cacheForRoot(root);
}

/**
 * Build a cache instance rooted at an explicit directory. Lets the daemon
 * reuse an already-resolved layout instead of re-running platform detection.
 */
export function cacheForRoot(root: string): PrStatusCache {
  // `layoutForRoot` defines the dispatch state layout; this cache lives
  // inside it under a `pr-status/` namespace so future protocols can claim
  // their own siblings without colliding.
  const baseDir = join(layoutForRoot(root).root, "pr-status");

  function prDir(target: CacheTarget): string {
    return join(
      baseDir,
      encodePathSegment(target.skill),
      encodeRepoSlug(target.repo),
      assertPositiveInt(target.pr).toString(10),
    );
  }
  function annDir(target: CacheTarget): string {
    return join(prDir(target), "annotations");
  }
  function ackPath(target: CacheTarget, id: string): string {
    return join(annDir(target), `${encodePathSegment(id)}.ack`);
  }

  return {
    prDir,
    read(target) {
      try {
        return readFileSync(join(prDir(target), "status.xml"), "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw err;
      }
    },
    write(target, xml) {
      const dir = prDir(target);
      mkdirSync(dir, { recursive: true });
      const tmp = join(dir, `status.xml.tmp.${process.pid}`);
      const final = join(dir, "status.xml");
      writeFileSync(tmp, xml);
      // rename is atomic on POSIX within the same directory.
      renameSync(tmp, final);
    },
    writeAck(target, annotationId) {
      const dir = annDir(target);
      mkdirSync(dir, { recursive: true });
      writeFileSync(ackPath(target, annotationId), "");
    },
    hasAck(target, annotationId) {
      return existsSync(ackPath(target, annotationId));
    },
    listAcks(target) {
      const dir = annDir(target);
      const out = new Set<string>();
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return out;
        throw err;
      }
      for (const entry of entries) {
        if (entry.endsWith(".ack")) {
          out.add(decodePathSegment(entry.slice(0, -".ack".length)));
        }
      }
      return out;
    },
    remove(target) {
      rmSync(prDir(target), { recursive: true, force: true });
    },
  };
}

/**
 * Encode `<owner>/<repo>` into a filename-safe slug per §Cache layout:
 * `/` becomes `__`; anything outside `[A-Za-z0-9._-]` is percent-encoded
 * so we can round-trip pathological characters without colliding with
 * the `__` separator.
 */
export function encodeRepoSlug(repo: string): string {
  const slash = repo.indexOf("/");
  if (slash === -1) {
    // No owner; encode the whole thing as one segment.
    return encodePathSegment(repo);
  }
  const owner = repo.slice(0, slash);
  const rest = repo.slice(slash + 1);
  return `${encodePathSegment(owner)}__${encodePathSegment(rest)}`;
}

const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

function encodePathSegment(segment: string): string {
  if (segment.length === 0) {
    throw new Error("path segment must not be empty");
  }
  if (SAFE_SEGMENT.test(segment)) return segment;
  // Percent-encode unsafe bytes. `%` itself is encoded so the result is
  // unambiguous and decodable. `/` becomes `%2F` rather than `__` so it
  // does not collide with the owner/repo separator.
  let out = "";
  for (const ch of segment) {
    if (/[A-Za-z0-9._-]/.test(ch)) {
      out += ch;
    } else {
      for (const byte of Buffer.from(ch, "utf8")) {
        out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
      }
    }
  }
  return out;
}

function decodePathSegment(segment: string): string {
  return segment.replace(/%([0-9A-F]{2})/g, (_, hex: string) =>
    Buffer.from([parseInt(hex, 16)]).toString("utf8"),
  );
}

function assertPositiveInt(n: number): number {
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`expected positive integer PR number, got ${String(n)}`);
  }
  return n;
}
