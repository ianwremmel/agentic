import type {Runner} from './exec.mts';
import {contentPresent} from './git.mts';
import {compareAheadBy, type PrJson} from './github.mts';

export interface TerminalInput {
  readonly run: Runner;
  readonly pr: PrJson;
  readonly owner: string;
  readonly repo: string;
}

/**
 * Resolve the PR's terminal end-to-end and render `<terminal>`. Binary at
 * closure (shipped|abandoned); non-terminal while the PR is live (open|draft).
 * Cheapest signals first — git is shelled only on the CLOSED-but-not-merged and
 * ahead_by>0 branch, never on the hot poll loop.
 */
export async function terminalXml({
  run,
  pr,
  owner,
  repo,
}: TerminalInput): Promise<string> {
  const state = pr.state ?? '';
  const mergedAt = pr.mergedAt ?? '';
  const baseRef = pr.baseRefName ?? '';
  const headOid = pr.headRefOid ?? '';
  const isDraft = pr.isDraft ?? false;
  const prNumber = pr.number ?? 0;

  const ghMerged =
    state === 'MERGED' || (mergedAt !== '' && mergedAt !== 'null');

  // Non-terminal: PR still open.
  if (state === 'OPEN') {
    const s = isDraft ? 'draft' : 'open';
    return `  <terminal state="${s}" gh-merged="${String(ghMerged)}" ahead-by="-"/>`;
  }

  // GitHub says merged → shipped. API only.
  if (ghMerged) {
    return '  <terminal state="shipped" gh-merged="true" ahead-by="-"/>';
  }

  // CLOSED without `merged`. One three-dot compare: ahead_by == 0 means every
  // head commit is already in base (plain merge / fast-forward / merge-queue
  // close where GitHub never set merged) → shipped, no git.
  const aheadBy = await compareAheadBy(run, owner, repo, baseRef, headOid);
  if (aheadBy === 0) {
    return '  <terminal state="shipped" gh-merged="false" ahead-by="0"/>';
  }

  // ahead_by > 0 (or compare failed): could be squash/rebase-landed or genuinely
  // abandoned; the API can't tell. Fall to the git content check. On a
  // git/fetch failure we do NOT guess — abandoned with an error breadcrumb, so
  // delivery is never falsely claimed.
  const ab = aheadBy === null ? '-' : String(aheadBy);
  const presence = await contentPresent({run, prNumber, baseRef});
  switch (presence) {
    case 'present':
      return `  <terminal state="shipped" gh-merged="false" ahead-by="${ab}"/>`;
    case 'absent':
      return `  <terminal state="abandoned" gh-merged="false" ahead-by="${ab}"/>`;
    default:
      return `  <terminal state="abandoned" gh-merged="false" ahead-by="${ab}" error="content-check-unavailable"/>`;
  }
}
