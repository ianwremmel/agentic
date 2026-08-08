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
    {timeout: 30_000, maxBuffer: 8 * 1024 * 1024}
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
      // What "known" means, and why numbers and branches are scoped
      // differently. A number is a PR's permanent identity: it is never reused
      // for a different PR, and re-adopting one can never help — upsert only
      // rewrites the pr row, it does not clear a stale outcome — so every
      // numbered row contributes its number, concluded or not. Re-adopting a
      // reopened-but-still-concluded PR would just churn a phantom adoption
      // each tick without ever making it live again.
      //
      // A branch is not an identity key. Two open PRs can share a head name
      // (same-named branches across forks), so a numbered row's branch must
      // not suppress a distinct fork PR that reuses it — the number already
      // guards that row. Only a row with no number yet contributes its branch:
      // a ticket-worker's registration made before its PR opens, which
      // adoption must not race. And only while that row is live — once it
      // concludes, its branch is free for later work to reuse, and a stale row
      // must not block adopting the new PR that inherits the name.
      const known = new Set<string>();
      for (const row of db.all(
        `SELECT p.branch AS branch, p.pr_number AS pr_number,
                o.node_id AS outcome_node
         FROM pr p
         LEFT JOIN outcome o ON o.node_id = p.node_id
         WHERE p.repo = ?`,
        [repo]
      )) {
        if (typeof row.pr_number === 'number')
          known.add(`#${String(row.pr_number)}`);
        else if (
          row.outcome_node === null &&
          typeof row.branch === 'string' &&
          row.branch !== ''
        )
          known.add(row.branch);
      }
      for (const pr of open) {
        // A listing with no number or head ref is malformed; skip it rather
        // than register a nameless item.
        if (!Number.isInteger(pr.number) || pr.headRefName === '') continue;
        if (known.has(`#${String(pr.number)}`) || known.has(pr.headRefName)) {
          continue;
        }
        // Remember the number so the same PR is not re-adopted; not the head
        // name, since a different fork PR can share it and still deserves a
        // row of its own.
        known.add(`#${String(pr.number)}`);
        // A branch led by a ticket id the graph holds is that ticket's work.
        const match = /^([a-z]+-\d+)/iu.exec(pr.headRefName);
        const ticketId = match?.[1]?.toUpperCase();
        const ticket =
          ticketId !== undefined && findNode(db, ticketId)?.kind === 'ticket'
            ? ticketId
            : null;
        await prs.upsertPr({
          id: `${repo}#${String(pr.number)}`,
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
