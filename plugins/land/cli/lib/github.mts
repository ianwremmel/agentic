import {EnvironmentError} from './errors.mts';
import type {Runner} from './exec.mts';

/** The `gh pr view --json` fields pr-status reads. */
export interface PrJson {
  readonly number?: number;
  readonly headRefName?: string;
  readonly headRefOid?: string;
  readonly baseRefName?: string;
  readonly state?: string;
  readonly mergedAt?: string | null;
  readonly mergeable?: string;
  readonly reviewDecision?: string;
  readonly isDraft?: boolean;
  readonly statusCheckRollup?: readonly unknown[];
}

const PR_VIEW_FIELDS =
  'number,headRefName,headRefOid,baseRefName,state,mergedAt,mergeable,reviewDecision,isDraft,statusCheckRollup';

const COMMENTS_QUERY = `
  query($owner:String!, $repo:String!, $pr:Int!, $endCursor:String) {
    repository(owner:$owner, name:$repo) {
      pullRequest(number:$pr) {
        comments(first:100, after:$endCursor) {
          nodes {
            id
            databaseId
            body
            author { login }
            reactions(first:100) { nodes { content user { login } } }
            reactionGroups { content viewerHasReacted }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }`;

const REVIEWS_QUERY = `
  query($owner:String!, $repo:String!, $pr:Int!, $endCursor:String) {
    repository(owner:$owner, name:$repo) {
      pullRequest(number:$pr) {
        reviews(first:100, after:$endCursor) {
          nodes { author { login __typename } state }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }`;

const THREADS_QUERY = `
  query($owner:String!, $repo:String!, $pr:Int!) {
    repository(owner:$owner, name:$repo) {
      pullRequest(number:$pr) {
        reviewThreads(first:100) {
          nodes {
            id
            isResolved
            comments(last:50) { nodes { body author { login } } }
          }
        }
      }
    }
  }`;

const REVIEW_REQUESTS_QUERY = `
  query($owner:String!, $repo:String!, $pr:Int!) {
    repository(owner:$owner, name:$repo) {
      pullRequest(number:$pr) {
        reviewRequests(first:100) {
          nodes {
            requestedReviewer {
              __typename
              ... on User { login }
              ... on Bot { login }
              ... on Mannequin { login }
              ... on Team { name slug }
            }
          }
        }
      }
    }
  }`;

/** A gh call that must succeed; a failure is fatal and names the tool. */
async function ghRequired(
  run: Runner,
  args: readonly string[]
): Promise<string> {
  let result;
  try {
    result = await run('gh', args);
  } catch (cause) {
    throw new EnvironmentError('could not run gh', {
      cause,
      hint: 'install the GitHub CLI (gh) and run `gh auth login`; pr-status needs it to read PR state.',
    });
  }
  if (result.code !== 0) {
    throw new EnvironmentError('gh exited non-zero', {
      details: {args: args.join(' '), code: result.code},
      hint: `check \`gh auth status\` and that the PR exists; gh said: ${result.stderr.trim() || '(no stderr)'}`,
    });
  }
  return result.stdout;
}

/** A gh call that may fail; the caller degrades with a default on failure. */
async function ghOptional(
  run: Runner,
  args: readonly string[]
): Promise<string | undefined> {
  try {
    const result = await run('gh', args);
    return result.code === 0 ? result.stdout : undefined;
  } catch {
    return undefined;
  }
}

/** Fail fast with a clear message when gh is not on PATH at all. */
export async function requireGh(run: Runner): Promise<void> {
  try {
    const result = await run('gh', ['--version']);
    if (result.code === 0) return;
  } catch {
    // fall through to the shared error
  }
  throw new EnvironmentError('required tool not found on PATH: gh', {
    hint: 'install the GitHub CLI (https://cli.github.com) and run `gh auth login`.',
  });
}

export async function repoNameWithOwner(run: Runner): Promise<string> {
  const raw = await ghRequired(run, [
    'repo',
    'view',
    '--json',
    'nameWithOwner',
  ]);
  const parsed = JSON.parse(raw) as {nameWithOwner?: string};
  const repo = parsed.nameWithOwner ?? '';
  if (repo === '') {
    throw new EnvironmentError('gh repo view returned no nameWithOwner', {
      hint: 'run pr-status from inside the repository worktree.',
    });
  }
  return repo;
}

export async function viewPr(run: Runner, pr: string): Promise<PrJson> {
  const raw = await ghRequired(run, [
    'pr',
    'view',
    pr,
    '--json',
    PR_VIEW_FIELDS,
  ]);
  return JSON.parse(raw) as PrJson;
}

/** The gh-authenticated login — the only identity the classifier trusts. */
export async function authenticatedLogin(run: Runner): Promise<string> {
  let raw: string | undefined;
  try {
    const result = await run('gh', ['api', 'user', '--jq', '.login']);
    raw = result.code === 0 ? result.stdout : undefined;
  } catch {
    raw = undefined;
  }
  const login = (raw ?? '').trim();
  if (login === '') {
    throw new EnvironmentError(
      'could not resolve the authenticated GitHub user (gh api user failed)',
      {
        hint: 'run `gh auth status`; without an identity pr-status cannot recognize the agent’s own items.',
      }
    );
  }
  return login;
}

interface GraphqlVars {
  readonly owner: string;
  readonly repo: string;
  readonly pr: number;
}

function graphqlArgs(
  query: string,
  vars: GraphqlVars,
  jq: string,
  paginate: boolean
): string[] {
  const args = ['api', 'graphql'];
  if (paginate) args.push('--paginate');
  args.push(
    '-F',
    `owner=${vars.owner}`,
    '-F',
    `repo=${vars.repo}`,
    '-F',
    `pr=${String(vars.pr)}`,
    '-f',
    `query=${query}`,
    '--jq',
    jq
  );
  return args;
}

/** Parse `gh --jq 'nodes[]'` NDJSON output (one node per line, across pages). */
function parseNdjson(raw: string): unknown[] {
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line): unknown => JSON.parse(line));
}

export async function fetchComments(
  run: Runner,
  vars: GraphqlVars
): Promise<unknown[]> {
  const raw = await ghRequired(
    run,
    graphqlArgs(
      COMMENTS_QUERY,
      vars,
      '.data.repository.pullRequest.comments.nodes[]',
      true
    )
  );
  return parseNdjson(raw);
}

export async function fetchReviews(
  run: Runner,
  vars: GraphqlVars
): Promise<unknown[]> {
  const raw = await ghRequired(
    run,
    graphqlArgs(
      REVIEWS_QUERY,
      vars,
      '.data.repository.pullRequest.reviews.nodes[]',
      true
    )
  );
  return parseNdjson(raw);
}

export async function fetchThreads(
  run: Runner,
  vars: GraphqlVars
): Promise<unknown[]> {
  const raw = await ghRequired(
    run,
    graphqlArgs(
      THREADS_QUERY,
      vars,
      '.data.repository.pullRequest.reviewThreads.nodes // []',
      false
    )
  );
  return JSON.parse(raw) as unknown[];
}

export async function fetchReviewRequests(
  run: Runner,
  vars: GraphqlVars
): Promise<unknown[]> {
  const raw = await ghRequired(
    run,
    graphqlArgs(
      REVIEW_REQUESTS_QUERY,
      vars,
      '.data.repository.pullRequest.reviewRequests.nodes // []',
      false
    )
  );
  return JSON.parse(raw) as unknown[];
}

/** Check runs for a commit; [] when the call fails (degrades gracefully). */
export async function fetchCheckRuns(
  run: Runner,
  owner: string,
  repo: string,
  sha: string
): Promise<unknown[]> {
  const raw = await ghOptional(run, [
    'api',
    `repos/${owner}/${repo}/commits/${sha}/check-runs`,
    '--jq',
    '.check_runs // []',
  ]);
  if (raw === undefined) return [];
  try {
    return JSON.parse(raw) as unknown[];
  } catch {
    return [];
  }
}

/** Annotations for a check run; [] when the call fails. */
export async function fetchAnnotations(
  run: Runner,
  owner: string,
  repo: string,
  runId: string
): Promise<unknown[]> {
  const raw = await ghOptional(run, [
    'api',
    `repos/${owner}/${repo}/check-runs/${runId}/annotations`,
  ]);
  if (raw === undefined) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as unknown[]) : [];
  } catch {
    return [];
  }
}

/**
 * `ahead_by` from a base...head compare, or null when the call fails. null lets
 * terminal resolution fall through to the git content check rather than guess.
 */
export async function compareAheadBy(
  run: Runner,
  owner: string,
  repo: string,
  base: string,
  head: string
): Promise<number | null> {
  const raw = await ghOptional(run, [
    'api',
    `repos/${owner}/${repo}/compare/${base}...${head}`,
    '--jq',
    '.ahead_by',
  ]);
  if (raw === undefined) return null;
  const value = Number(raw.trim());
  return Number.isInteger(value) ? value : null;
}
