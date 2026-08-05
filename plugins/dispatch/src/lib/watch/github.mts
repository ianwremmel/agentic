import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

import {DataError, EnvironmentError, ensure} from '../errors/index.mts';

const run = promisify(execFile);

/**
 * The structural fields a waiting worker cares about: a change in any of them
 * is what ends a CI, review, or merge wait. `updatedAt` is deliberately
 * absent — it moves on every write, including the agent's own, and would fire
 * every watch immediately.
 */
const QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      headRefOid
      state
      isDraft
      reviewDecision
      totalCommentsCount
      comments { totalCount }
      reviews { totalCount }
      reviewThreads(last: 100) { totalCount nodes { isResolved } }
      commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
    }
  }
}`;

interface PrShape {
  headRefOid?: string;
  state?: string;
  isDraft?: boolean;
  reviewDecision?: string | null;
  /** Issue and review comments together — a reply inside an existing thread
   * moves this count when nothing else in the shape changes. */
  totalCommentsCount?: number;
  comments?: {totalCount?: number};
  reviews?: {totalCount?: number};
  reviewThreads?: {totalCount?: number; nodes?: {isResolved?: boolean}[]};
  commits?: {
    nodes?: {commit?: {statusCheckRollup?: {state?: string} | null}}[];
  };
}

/** Fingerprint a PR through `gh api graphql`: one call, one stable string. */
export async function githubFingerprint(
  repo: string,
  prNumber: number
): Promise<string> {
  ensure(
    /^[^/\s]+\/[^/\s]+$/u.test(repo),
    () =>
      new DataError(`"${repo}" is not an owner/repo`, {
        hint: 'record the PR item with --repo <owner>/<name> before watching it.',
      })
  );
  const [owner, name] = repo.split('/') as [string, string];
  let stdout: string;
  try {
    ({stdout} = await run('gh', [
      'api',
      'graphql',
      '-f',
      `query=${QUERY}`,
      '-F',
      `owner=${owner}`,
      '-F',
      `name=${name}`,
      '-F',
      `number=${String(prNumber)}`,
    ]));
  } catch (error) {
    throw new EnvironmentError(
      `gh could not fingerprint ${repo}#${String(prNumber)}: ${error instanceof Error ? error.message : String(error)}`,
      {hint: 'check gh auth status and that the PR still exists.'}
    );
  }
  const parsed = JSON.parse(stdout) as {
    data?: {repository?: {pullRequest?: PrShape | null} | null};
  };
  const pr = parsed.data?.repository?.pullRequest;
  ensure(
    pr !== undefined && pr !== null,
    () =>
      new DataError(`no pull request ${repo}#${String(prNumber)}`, {
        hint: 'the PR item names a PR the forge does not have; fix its --repo/--pr-number.',
      })
  );
  return JSON.stringify({
    head: pr.headRefOid ?? null,
    state: pr.state ?? null,
    draft: pr.isDraft ?? null,
    decision: pr.reviewDecision ?? null,
    allComments: pr.totalCommentsCount ?? 0,
    comments: pr.comments?.totalCount ?? 0,
    reviews: pr.reviews?.totalCount ?? 0,
    threads: pr.reviewThreads?.totalCount ?? 0,
    resolved: (pr.reviewThreads?.nodes ?? []).filter(
      (thread) => thread.isResolved === true
    ).length,
    checks: pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state ?? null,
  });
}
