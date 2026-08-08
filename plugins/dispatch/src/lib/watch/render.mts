import type {PrSnapshot} from './snapshot.mts';

/**
 * Render an event body from the snapshot the server already holds.
 *
 * This replaced shelling out to `pr-status` per event. That script makes
 * several `gh` calls, writes cache files, and invokes `claude` to summarize —
 * a deep read a worker runs for itself when it needs actionability and cached
 * bodies. The event body's job is smaller: say where the PR stands, in the
 * same XML vocabulary the worker already reads, so one wakeup carries
 * everything one tick saw without costing a subprocess per event.
 */
export function renderSnapshot(
  repo: string,
  prNumber: number,
  snapshot: PrSnapshot
): string {
  const lines: string[] = [];
  const esc = (value: string): string =>
    value
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('"', '&quot;');

  lines.push(
    `<pr-event repo="${esc(repo)}" pr="${String(prNumber)}" head="${esc(snapshot.head ?? '')}" state="${esc(snapshot.state ?? '')}" draft="${String(snapshot.draft)}" merged="${String(snapshot.merged)}">`
  );
  const rollup = snapshot.rollup ?? 'NONE';
  lines.push(`  <checks state="${esc(rollup)}">`);
  for (const check of snapshot.checks) {
    lines.push(
      `    <check name="${esc(check.name)}" conclusion="${esc(check.conclusion ?? 'PENDING')}"${check.url === null ? '' : ` url="${esc(check.url)}"`}/>`
    );
  }
  lines.push('  </checks>');
  lines.push(
    `  <merge-conflicts present="${String(snapshot.mergeState === 'DIRTY')}"/>`
  );
  lines.push(
    `  <review-decision>${esc(snapshot.reviewDecision ?? 'NONE')}</review-decision>`
  );
  lines.push('  <reviews>');
  for (const review of snapshot.reviews) {
    lines.push(
      `    <review author="${esc(review.author)}" state="${esc(review.state)}" mine="${String(review.mine)}"/>`
    );
  }
  lines.push('  </reviews>');
  lines.push('  <threads>');
  for (const thread of snapshot.threads) {
    lines.push(
      `    <thread id="${esc(thread.id)}" resolved="${String(thread.resolved)}" lastAuthor="${esc(thread.lastAuthor ?? '')}" mine="${String(thread.mine)}"/>`
    );
  }
  lines.push('  </threads>');
  lines.push(
    `  <note>Snapshot rendered by the server. For actionability classification and cached bodies, run pr-status --repo ${esc(repo)} ${String(prNumber)} yourself.</note>`
  );
  lines.push('</pr-event>');
  return lines.join('\n');
}
