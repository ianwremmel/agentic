import {randomUUID} from 'node:crypto';
import {unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import type {Runner} from './exec.mts';

/**
 * Whether the PR's net change is present in the base tip.
 *   - `present`  → shipped (merge, fast-forward, squash, or rebase landed it)
 *   - `absent`   → abandoned (closed with the change not in base)
 *   - `unknown`  → the check could not run (no repo, or a git/fetch failure); the
 *                  caller must not guess delivery from this
 *
 * Squash/rebase-safe: it builds the PR's combined net patch and reverse-applies
 * it against a temp index seeded from the base tip, so an n→1 squash or a rebase
 * rewrite still matches by content (per-commit patch-ids break under squash).
 * Side-effect-free — it never touches the caller's worktree, index, or HEAD.
 */
export type ContentPresence = 'present' | 'absent' | 'unknown';

export interface ContentPresentInput {
  readonly run: Runner;
  readonly prNumber: number;
  readonly baseRef: string;
}

export async function contentPresent({
  run,
  prNumber,
  baseRef,
}: ContentPresentInput): Promise<ContentPresence> {
  const git = async (
    args: readonly string[],
    opts?: {stdin?: string; env?: Record<string, string>}
  ): Promise<{code: number; stdout: string} | undefined> => {
    try {
      const result = await run('git', args, opts);
      return {code: result.code, stdout: result.stdout};
    } catch {
      // git not on PATH, or spawn failure.
      return undefined;
    }
  };

  const inRepo = await git(['rev-parse', '--git-dir']);
  if (inRepo?.code !== 0) return 'unknown';

  // Fetch the head commit by SHA via refs/pull/<n>/head — the head branch may
  // have been deleted on close, but GitHub keeps the SHA reachable here.
  const headSha = await fetchRef(git, `refs/pull/${String(prNumber)}/head`);
  if (headSha === undefined) return 'unknown';

  // FETCH_HEAD is overwritten by the next fetch, so head_sha was captured first.
  const baseSha = await fetchRef(git, baseRef);
  if (baseSha === undefined) return 'unknown';

  const mergeBase = await git(['merge-base', baseSha, headSha]);
  if (mergeBase?.code !== 0) return 'unknown';
  const mb = mergeBase.stdout.trim();
  if (mb === '') return 'unknown';

  // No-op PR: an empty net patch is trivially present in base → shipped. Must be
  // short-circuited because `git apply --check` rejects empty input.
  const emptyDiff = await git(['diff', '--quiet', mb, headSha]);
  if (emptyDiff?.code === 0) return 'present';

  // Reverse-apply the net patch against a temp index seeded from the base tip.
  // The index path must not pre-exist: some git versions read an existing empty
  // GIT_INDEX_FILE as a corrupt index and fail read-tree.
  const tmpIndex = join(tmpdir(), `land-index-${randomUUID()}`);
  try {
    const readTree = await git(['read-tree', baseSha], {
      env: {GIT_INDEX_FILE: tmpIndex},
    });
    if (readTree?.code !== 0) return 'unknown';

    // --binary makes an applyable full patch; without it a binary file becomes a
    // "Binary files differ" placeholder git apply rejects.
    const diff = await git(['diff', '--binary', mb, headSha]);
    if (diff?.code !== 0) return 'absent';

    const applied = await git(
      ['apply', '--reverse', '--cached', '--check', '-'],
      {stdin: diff.stdout, env: {GIT_INDEX_FILE: tmpIndex}}
    );
    return applied?.code === 0 ? 'present' : 'absent';
  } finally {
    await unlink(tmpIndex).catch(() => undefined);
  }
}

/** Fetch a ref and return the resolved FETCH_HEAD sha, or undefined on failure. */
async function fetchRef(
  git: (
    args: readonly string[],
    opts?: {stdin?: string; env?: Record<string, string>}
  ) => Promise<{code: number; stdout: string} | undefined>,
  ref: string
): Promise<string | undefined> {
  const fetched = await git(['fetch', '--quiet', 'origin', ref]);
  if (fetched?.code !== 0) return undefined;
  const resolved = await git([
    'rev-parse',
    '--verify',
    '--quiet',
    'FETCH_HEAD',
  ]);
  if (resolved?.code !== 0) return undefined;
  const sha = resolved.stdout.trim();
  return sha === '' ? undefined : sha;
}
