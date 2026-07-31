import type {Writable} from 'node:stream';

import {parseArgsOrUsage} from './lib/args.mts';
import {annotationsXml} from './lib/annotations.mts';
import {checksXml, type RollupEntry} from './lib/checks.mts';
import {
  informationalPattern,
  resolveCacheDir,
  resolveOperatorLogin,
  stuckAfterSeconds,
} from './lib/config.mts';
import {commentsXml} from './lib/comments.mts';
import {assertUsage, EnvironmentError, EXIT_OK} from './lib/errors.mts';
import {type Runner, spawnRunner} from './lib/exec.mts';
import {type FileSystem, nodeFs} from './lib/fsx.mts';
import {
  authenticatedLogin,
  fetchComments,
  fetchReviewRequests,
  fetchReviews,
  fetchThreads,
  repoNameWithOwner,
  requireGh,
  viewPr,
} from './lib/github.mts';
import {writeLine} from './lib/io.mts';
import {createLogger, resolveLogLevel} from './lib/log/logger.mts';
import {
  reviewsXml,
  type ReviewNode,
  type ReviewRequestNode,
} from './lib/reviews.mts';
import {terminalXml} from './lib/terminal.mts';
import {threadsXml} from './lib/threads.mts';
import {attr} from './lib/xml.mts';

const USAGE = 'pr-status [--log-level <level>] <pr>';

export interface RunOptions {
  readonly stdout: Writable;
  readonly stderr: Writable;
  readonly env: NodeJS.ProcessEnv;
  /** Injected for tests; defaults to a real child process. */
  readonly run?: Runner;
  /** Injected for tests; defaults to node:fs. */
  readonly fs?: FileSystem;
  /** Injected for deterministic check-staleness; defaults to the wall clock. */
  readonly now?: () => Date;
  /** Injected for tests; defaults to process.cwd(). */
  readonly cwd?: () => string;
}

/**
 * Parse argv, gather the PR's state from the forge, and emit the pr-status XML
 * on stdout. Returns the exit code; throws a {@link LandError} for anything the
 * caller can act on (bad flags, a missing tool, an unconfigured operator).
 */
export async function run(
  argv: readonly string[],
  options: RunOptions
): Promise<number> {
  const {stdout, stderr, env} = options;
  const runner = options.run ?? spawnRunner;
  const fs = options.fs ?? nodeFs;
  const nowMs = (options.now ?? (() => new Date()))().getTime();
  const cwd = options.cwd ?? (() => process.cwd());

  const {values, positionals} = parseArgsOrUsage({
    args: [...argv],
    options: {
      help: {type: 'boolean', short: 'h'},
      'log-level': {type: 'string'},
    },
    allowPositionals: true,
    strict: true,
  });

  const level = resolveLogLevel(values['log-level'] ?? env.LAND_LOG_LEVEL);
  const log = createLogger({
    stream: stderr,
    level,
    ...(options.now ? {now: options.now} : {}),
  });

  if (values.help === true) {
    await writeLine(stdout, `usage: ${USAGE}`);
    return EXIT_OK;
  }

  assertUsage(
    positionals.length <= 1,
    `pr-status takes exactly one PR, got ${String(positionals.length)}\n\nusage: ${USAGE}`
  );
  const pr = positionals[0];
  assertUsage(
    pr !== undefined && pr !== '',
    `pr-status needs a PR (number, URL, or branch)\n\nusage: ${USAGE}`
  );

  await requireGh(runner);

  const repo = await repoNameWithOwner(runner);
  const [owner, repoName] = splitRepo(repo);

  const projectRoot = await resolveProjectRoot(runner, env, cwd);
  const {login: operatorLogin, warnings} = await resolveOperatorLogin({
    env,
    projectRoot,
  });
  for (const warning of warnings) {
    await writeLine(stderr, `pr-status: warning: ${warning}`);
  }
  if (operatorLogin === undefined) {
    throw new EnvironmentError('operator_login is not set', {
      hint: 'the operator must set operator_login in the land plugin config (or export CLAUDE_PLUGIN_OPTION_OPERATOR_LOGIN) — pr-status cannot classify reviews without it.',
    });
  }

  const callerLogin = await authenticatedLogin(runner);

  const prJson = await viewPr(runner, pr);
  const prNumber = prJson.number ?? 0;
  const head = prJson.headRefName ?? '';
  const vars = {owner, repo: repoName, pr: prNumber};

  await log.debug('fetched PR', {repo, pr, number: prNumber});

  // Independent forge reads; gather them together to cut wall-clock latency.
  const [comments, threads, reviews, reviewRequests] = await Promise.all([
    fetchComments(runner, vars),
    fetchThreads(runner, vars),
    fetchReviews(runner, vars),
    fetchReviewRequests(runner, vars),
  ]);

  const dir = resolveCacheDir(env, repo, pr);
  await Promise.all([
    fs.mkdirp(`${dir}/comments`),
    fs.mkdirp(`${dir}/threads`),
    fs.mkdirp(`${dir}/annotations`),
  ]);

  const sections = [
    `<pr-status repo="${attr(repo)}" pr="${attr(pr)}" head="${attr(head)}">`,
    await terminalXml({run: runner, pr: prJson, owner, repo: repoName}),
    checksXml((prJson.statusCheckRollup ?? []) as RollupEntry[], {
      informationalRe: informationalPattern(env),
      stuckAfterSec: stuckAfterSeconds(env),
      nowMs,
    }),
    conflictsXml(prJson.mergeable),
    reviewsXml(
      {
        reviews: {nodes: reviews as ReviewNode[]},
        reviewRequests: {nodes: reviewRequests as ReviewRequestNode[]},
      },
      operatorLogin
    ),
    await commentsXml({fs, run: runner, dir, callerLogin, comments}),
    await threadsXml({fs, run: runner, dir, callerLogin, threads}),
    await annotationsXml({
      fs,
      run: runner,
      dir,
      owner,
      repo: repoName,
      sha: prJson.headRefOid ?? '',
    }),
    '</pr-status>',
  ];

  await writeLine(stdout, sections.join('\n'));
  await log.info('emitted pr-status', {repo, pr});
  return EXIT_OK;
}

function conflictsXml(mergeable: string | undefined): string {
  const present = mergeable === 'CONFLICTING';
  return `  <merge-conflicts present="${String(present)}"/>`;
}

function splitRepo(repo: string): [string, string] {
  const slash = repo.indexOf('/');
  return [repo.slice(0, slash), repo.slice(slash + 1)];
}

/**
 * The repo root, for locating `.claude` settings: the harness-injected project
 * dir, else the enclosing git worktree, else the process cwd.
 */
async function resolveProjectRoot(
  runner: Runner,
  env: NodeJS.ProcessEnv,
  cwd: () => string
): Promise<string> {
  if (env.CLAUDE_PROJECT_DIR !== undefined && env.CLAUDE_PROJECT_DIR !== '') {
    return env.CLAUDE_PROJECT_DIR;
  }
  try {
    const result = await runner('git', ['rev-parse', '--show-toplevel']);
    const top = result.stdout.trim();
    if (result.code === 0 && top !== '') return top;
  } catch {
    // no git; fall through to cwd
  }
  return cwd();
}
