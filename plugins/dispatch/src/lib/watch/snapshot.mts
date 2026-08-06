import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

import {DataError, EnvironmentError, ensure} from '../errors/index.mts';
import {writtenByThisAgent} from './marker.mts';

const run = promisify(execFile);

/**
 * Everything one poll needs to decide what changed and say so specifically.
 *
 * `updatedAt` is deliberately absent: it moves on every write, including the
 * agent's own, so a snapshot carrying it would report a change every time the
 * worker touched its own PR. Each field here is instead something a waiting
 * worker would act on.
 */
export const SNAPSHOT_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      headRefOid
      state
      isDraft
      merged
      mergeable
      mergeStateStatus
      reviewDecision
      reviews(last: 20) {
        totalCount
        nodes { author { login } state submittedAt body }
      }
      reviewThreads(last: 50) {
        totalCount
        nodes {
          id
          isResolved
          isOutdated
          comments(last: 1) { nodes { author { login } createdAt body } }
        }
      }
      comments(last: 30) {
        totalCount
        nodes { id author { login } createdAt body }
      }
      commits(last: 1) {
        nodes {
          commit {
            statusCheckRollup {
              state
              contexts(last: 50) {
                nodes {
                  __typename
                  ... on CheckRun {
                    name
                    conclusion
                    status
                    detailsUrl
                  }
                  ... on StatusContext {
                    context
                    state
                    targetUrl
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}`;

export interface CheckState {
  readonly name: string;
  /** `null` while the check is still running. */
  readonly conclusion: string | null;
  readonly url: string | null;
}

export interface ReviewState {
  readonly author: string;
  readonly state: string;
  readonly submittedAt: string | null;
  /** Carries this agent's machine marker; see `marker.mts`. */
  readonly mine: boolean;
}

export interface ThreadState {
  readonly id: string;
  readonly resolved: boolean;
  readonly outdated: boolean;
  readonly lastAuthor: string | null;
  readonly lastAt: string | null;
  readonly mine: boolean;
}

export interface CommentState {
  readonly id: string;
  readonly author: string;
  readonly createdAt: string;
  readonly mine: boolean;
}

export interface PrSnapshot {
  readonly head: string | null;
  readonly state: string | null;
  readonly draft: boolean;
  readonly merged: boolean;
  readonly mergeable: string | null;
  readonly mergeState: string | null;
  readonly reviewDecision: string | null;
  readonly rollup: string | null;
  readonly checks: readonly CheckState[];
  readonly reviews: readonly ReviewState[];
  readonly threads: readonly ThreadState[];
  readonly comments: readonly CommentState[];
  /**
   * Totals as the forge reports them, against the windows the query asks for.
   * A total past its window means the snapshot is missing older entries, and
   * the diff must not read "absent from my window" as "deleted".
   */
  readonly totals: {
    readonly reviews: number;
    readonly threads: number;
    readonly comments: number;
  };
}

interface RawContext {
  __typename?: string;
  name?: string;
  conclusion?: string | null;
  status?: string | null;
  detailsUrl?: string | null;
  context?: string;
  state?: string | null;
  targetUrl?: string | null;
}

interface RawPr {
  headRefOid?: string;
  state?: string;
  isDraft?: boolean;
  merged?: boolean;
  mergeable?: string | null;
  mergeStateStatus?: string | null;
  reviewDecision?: string | null;
  reviews?: {
    totalCount?: number;
    nodes?: {
      author?: {login?: string} | null;
      state?: string;
      submittedAt?: string | null;
      body?: string;
    }[];
  };
  reviewThreads?: {
    totalCount?: number;
    nodes?: {
      id?: string;
      isResolved?: boolean;
      isOutdated?: boolean;
      comments?: {
        nodes?: {
          author?: {login?: string} | null;
          createdAt?: string;
          body?: string;
        }[];
      };
    }[];
  };
  comments?: {
    totalCount?: number;
    nodes?: {
      id?: string;
      author?: {login?: string} | null;
      createdAt?: string;
      body?: string;
    }[];
  };
  commits?: {
    nodes?: {
      commit?: {
        statusCheckRollup?: {
          state?: string;
          contexts?: {nodes?: RawContext[]};
        } | null;
      };
    }[];
  };
}

/**
 * A status context reports `state`; a check run reports `conclusion` once it
 * finishes and `status` while it runs. Normalizing both onto "conclusion or
 * null-while-running" is what lets the diff talk about checks without caring
 * which kind produced them.
 */
function toCheck(context: RawContext): CheckState | null {
  if (typeof context.name === 'string') {
    const running = context.status !== 'COMPLETED';
    return {
      name: context.name,
      conclusion: running ? null : (context.conclusion ?? null),
      url: context.detailsUrl ?? null,
    };
  }
  if (typeof context.context === 'string') {
    const state = context.state ?? null;
    return {
      name: context.context,
      conclusion: state === 'PENDING' || state === null ? null : state,
      url: context.targetUrl ?? null,
    };
  }
  return null;
}

function parse(pr: RawPr): PrSnapshot {
  const rollupNode = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup ?? null;
  return {
    head: pr.headRefOid ?? null,
    state: pr.state ?? null,
    draft: pr.isDraft === true,
    merged: pr.merged === true,
    mergeable: pr.mergeable ?? null,
    mergeState: pr.mergeStateStatus ?? null,
    reviewDecision: pr.reviewDecision ?? null,
    rollup: rollupNode?.state ?? null,
    checks: (rollupNode?.contexts?.nodes ?? [])
      .map(toCheck)
      .filter((check): check is CheckState => check !== null)
      .sort((a, b) => a.name.localeCompare(b.name)),
    reviews: (pr.reviews?.nodes ?? []).map((review) => ({
      author: review.author?.login ?? '',
      state: review.state ?? '',
      submittedAt: review.submittedAt ?? null,
      mine: writtenByThisAgent(review.body),
    })),
    threads: (pr.reviewThreads?.nodes ?? []).map((thread) => {
      const last = thread.comments?.nodes?.at(-1);
      return {
        id: thread.id ?? '',
        resolved: thread.isResolved === true,
        outdated: thread.isOutdated === true,
        lastAuthor: last?.author?.login ?? null,
        lastAt: last?.createdAt ?? null,
        mine: writtenByThisAgent(last?.body),
      };
    }),
    comments: (pr.comments?.nodes ?? []).map((comment) => ({
      id: comment.id ?? '',
      author: comment.author?.login ?? '',
      createdAt: comment.createdAt ?? '',
      mine: writtenByThisAgent(comment.body),
    })),
    totals: {
      reviews: pr.reviews?.totalCount ?? 0,
      threads: pr.reviewThreads?.totalCount ?? 0,
      comments: pr.comments?.totalCount ?? 0,
    },
  };
}

export type Snapshotter = (
  repo: string,
  prNumber: number
) => Promise<PrSnapshot>;

/** Snapshot a PR through `gh api graphql`: one call per poll. */
export const githubSnapshot: Snapshotter = async (repo, prNumber) => {
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
      `query=${SNAPSHOT_QUERY}`,
      '-F',
      `owner=${owner}`,
      '-F',
      `name=${name}`,
      '-F',
      `number=${String(prNumber)}`,
    ]));
  } catch (error) {
    throw new EnvironmentError(
      `gh could not read ${repo}#${String(prNumber)}: ${error instanceof Error ? error.message : String(error)}`,
      {hint: 'check gh auth status and that the PR still exists.'}
    );
  }
  const parsed = JSON.parse(stdout) as {
    data?: {repository?: {pullRequest?: RawPr | null} | null};
  };
  const pr = parsed.data?.repository?.pullRequest;
  ensure(
    pr !== undefined && pr !== null,
    () =>
      new DataError(`no pull request ${repo}#${String(prNumber)}`, {
        hint: 'the PR item names a PR the forge does not have; fix its --repo/--pr-number.',
      })
  );
  return parse(pr);
};
