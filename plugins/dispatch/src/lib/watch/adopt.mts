import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

import {withDatabase} from '../db/index.mts';
import {nowIso} from '../db/time.mts';
import type {Logger} from '../logger/index.mts';
import {PrStore} from '../stores/index.mts';
import {findNode} from '../stores/materialize.mts';

const run = promisify(execFile);

export interface OpenPr {
  readonly number: number;
  readonly headRefName: string;
}

export type PrLister = (repo: string) => Promise<OpenPr[]>;

/** Open PRs authored by this identity, via gh. */
export const githubLister: PrLister = async (repo) => {
  const {stdout} = await run(
    'gh',
    [
      'pr',
      'list',
      '--repo',
      repo,
      '--author',
      '@me',
      '--state',
      'open',
      '--json',
      'number,headRefName',
    ],
    {timeout: 30_000}
  );
  return JSON.parse(stdout) as OpenPr[];
};

/**
 * Adopt agent-authored PRs the graph does not know.
 *
 * Registered PR items are runtime state: a database rebuild loses them, and a
 * worker crash can leave a PR open that nothing ever registered. An orphaned
 * PR has no watch and no worker, so it goes stale silently. This runs on the
 * tick cadence rather than as a one-off reconciliation: every open PR this
 * identity authored, in every repo the graph already knows, gets a PR item —
 * `origin adopted`, ticket-linked when the branch leads with a ticket id the
 * graph holds — and the existing machinery watches and schedules it like
 * anything else.
 *
 * Repos come from existing PR items, so adoption never reaches into a repo
 * the project has not already touched.
 */
export async function adoptOrphans(
  env: NodeJS.ProcessEnv,
  opts: {
    list?: PrLister;
    dbPath?: string | undefined;
    log?: Logger | undefined;
  } = {}
): Promise<number> {
  const list = opts.list ?? githubLister;
  return withDatabase(opts.dbPath, env, async (db) => {
    const prs = new PrStore(db);
    const repos = db
      .all('SELECT DISTINCT repo FROM pr WHERE repo IS NOT NULL')
      .map((row) => String(row.repo));
    let adopted = 0;
    for (const repo of repos) {
      let open: OpenPr[];
      try {
        open = await list(repo);
      } catch (error) {
        opts.log?.warn('adoption listing failed', {
          repo,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      const known = new Set(
        db
          .all('SELECT branch, pr_number FROM pr WHERE repo = ?', [repo])
          .flatMap((row) => [
            typeof row.branch === 'string' ? row.branch : '',
            `#${typeof row.pr_number === 'number' ? String(row.pr_number) : ''}`,
          ])
      );
      for (const pr of open) {
        if (known.has(pr.headRefName) || known.has(`#${String(pr.number)}`)) {
          continue;
        }
        // A branch led by a ticket id the graph holds is that ticket's work.
        const match = /^([a-z]+-\d+)/iu.exec(pr.headRefName);
        const ticketId = match?.[1]?.toUpperCase();
        const ticket =
          ticketId !== undefined && findNode(db, ticketId)?.kind === 'ticket'
            ? ticketId
            : null;
        await prs.upsertPr({
          id: `${repo}#${pr.headRefName}`,
          ticket,
          origin: 'adopted',
          repo,
          prNumber: pr.number,
          url: `https://github.com/${repo}/pull/${String(pr.number)}`,
          branch: pr.headRefName,
          title: `Adopted open PR #${String(pr.number)} (${pr.headRefName})`,
          injected: false,
          priority: null,
          updatedAt: nowIso(),
        });
        adopted += 1;
      }
    }
    return adopted;
  });
}
