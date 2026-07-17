import type {Pass} from './queries.mts';
import {GROUP_OF} from './roles.mts';
import type {ClassifiedNode, DerivedGraph} from './types.mts';

/**
 * The §2.6 project-graph document: the orchestrator's whole view of project
 * state. The derived sections (`available`, `blocked`, `human-blocked`,
 * `milestones`, `counts`, `anomalies`) are authoritative — a consumer reads them
 * rather than re-deriving from the node and edge lists, which are carried for
 * context.
 */
export function toXml(graph: DerivedGraph): string {
  const cursor = Object.entries(graph.cursors)
    .map(([source, value]) => `${source}=${value}`)
    .join(' ');

  const out: string[] = [`<project-graph cursor="${attr(cursor)}">`];

  out.push('  <projects>');
  for (const project of graph.projects) {
    out.push(
      `    <project id="${attr(project.id)}" name="${attr(project.name)}" partial="${String(project.partial)}" terminal="${String(project.terminal)}"/>`
    );
  }
  out.push('  </projects>');

  out.push('  <nodes>');
  for (const entry of graph.nodes) out.push(nodeXml(entry));
  out.push('  </nodes>');

  out.push('  <edges>');
  for (const edge of graph.edges) {
    out.push(
      `    <edge blocker="${attr(edge.blocker)}" blocked="${attr(edge.blocked)}"/>`
    );
  }
  out.push('  </edges>');

  out.push('  <available>');
  graph.available.forEach((entry, index) => {
    out.push(`    ${availableTicket(entry, index + 1)}`);
  });
  out.push('  </available>');

  out.push('  <blocked>');
  for (const entry of graph.blocked) {
    out.push(
      `    <ticket id="${attr(entry.node.id)}" blocked-by="${attr(entry.blockedBy.join(','))}" gated-by="${attr(entry.gatedBy.join(','))}"/>`
    );
  }
  out.push('  </blocked>');

  out.push('  <human-blocked>');
  for (const entry of graph.humanBlocked) {
    out.push(
      `    <ticket id="${attr(entry.node.id)}" url="${attr(entry.node.url)}" role="${attr(entry.node.role)}" reason="${attr(humanReason(entry))}"/>`
    );
  }
  out.push('  </human-blocked>');

  out.push('  <milestones>');
  for (const milestone of graph.milestones) {
    out.push(`    ${milestoneXml(milestone)}`);
  }
  out.push('  </milestones>');

  out.push('  <counts>');
  for (const count of graph.counts) {
    out.push(
      `    <project id="${attr(count.project)}" partial="${String(count.partial)}" total="${String(count.total)}" available="${String(count.available)}" blocked="${String(count.blocked)}" human-blocked="${String(count.humanBlocked)}" in-flight="${String(count.inFlight)}" dormant="${String(count.dormant)}" verified="${String(count.verified)}" canceled="${String(count.canceled)}" terminal="${String(count.terminal)}"/>`
    );
  }
  out.push('  </counts>');

  out.push('  <anomalies>');
  for (const anomaly of graph.anomalies) {
    out.push(
      `    <anomaly kind="${attr(anomaly.kind)}" nodes="${attr(anomaly.nodes.join(','))}">${text(anomaly.detail)}</anomaly>`
    );
  }
  out.push('  </anomalies>');

  out.push('</project-graph>');
  return out.join('\n');
}

/** The same derived view as JSON, for a caller that would rather not parse XML. */
export function toJson(graph: DerivedGraph): string {
  return JSON.stringify(
    {
      cursors: graph.cursors,
      projects: graph.projects,
      nodes: graph.nodes.map((entry) => ({
        ...entry.node,
        group: GROUP_OF[entry.node.role],
        state: entry.classification,
        effectiveBlocked: entry.effectiveBlocked,
        blockedBy: entry.blockedBy,
        gatedBy: entry.gatedBy,
        claim: entry.claim,
        outcome: entry.outcome,
      })),
      edges: graph.edges,
      available: graph.available.map((entry, index) => ({
        id: entry.node.id,
        rank: index + 1,
        url: entry.node.url,
        targetKind: entry.node.targetKind,
        branchHint: entry.node.branchHint,
      })),
      blocked: graph.blocked.map((entry) => ({
        id: entry.node.id,
        blockedBy: entry.blockedBy,
        gatedBy: entry.gatedBy,
      })),
      humanBlocked: graph.humanBlocked.map((entry) => ({
        id: entry.node.id,
        url: entry.node.url,
        role: entry.node.role,
        reason: humanReason(entry),
      })),
      milestones: graph.milestones,
      counts: graph.counts,
      anomalies: graph.anomalies,
    },
    null,
    2
  );
}

/**
 * One `<ticket>` element for the available frontier. Shared by the document and
 * by `graph next`, so an agent picking work parses the same XML shape wherever it
 * comes from. `rank` is omitted when there is nothing to rank against (a lone
 * `next` result); `pass` marks a follow-up dispatch on already-reported work;
 * `agent` is the claim's holder when the claim was taken as part of the print
 * (`next --claim`, `fill`).
 */
export function availableTicket(
  entry: ClassifiedNode,
  rank?: number,
  pass?: Pass | null,
  agent?: string
): string {
  const rankAttr = rank === undefined ? '' : ` rank="${String(rank)}"`;
  const passAttr =
    pass === undefined || pass === null ? '' : ` pass="${attr(pass)}"`;
  const agentAttr = agent === undefined ? '' : ` agent="${attr(agent)}"`;
  return (
    `<ticket id="${attr(entry.node.id)}"${rankAttr}${passAttr}${agentAttr} ` +
    `target-kind="${attr(entry.node.targetKind)}" url="${attr(entry.node.url)}"${branchAttr(entry)}/>`
  );
}

function milestoneXml(milestone: DerivedGraph['milestones'][number]): string {
  return `<milestone ${milestoneAttrs(milestone)}/>`;
}

function milestoneAttrs(milestone: DerivedGraph['milestones'][number]): string {
  const claim =
    milestone.claim === null
      ? ''
      : ` claimed-by="${attr(milestone.claim.agent)}" claim-live="${String(milestone.claim.live)}"`;
  return `id="${attr(milestone.id)}" project="${attr(milestone.project)}" name="${attr(milestone.name)}" ready-for-review="${String(milestone.readyForReview)}" review-recorded="${String(milestone.reviewRecorded)}"${claim} open="${String(milestone.openCount)}" total="${String(milestone.memberCount)}" verified="${String(milestone.verified)}" canceled="${String(milestone.canceled)}" in-flight="${String(milestone.inFlight)}" blocked="${String(milestone.blocked)}"`;
}

/**
 * One milestone with its member nodes — the milestone-review agent's read:
 * the gate state plus every member it must judge, without the rest of the
 * graph. Returns null when the graph has no such milestone.
 */
export function toMilestoneXml(graph: DerivedGraph, id: string): string | null {
  const milestone = graph.milestones.find((entry) => entry.id === id);
  if (milestone === undefined) return null;

  const out = [`<milestone ${milestoneAttrs(milestone)}>`, '  <members>'];
  for (const entry of graph.nodes) {
    if (entry.node.milestone === id) out.push(nodeXml(entry));
  }
  out.push('  </members>', '</milestone>');
  return out.join('\n');
}

/**
 * The orchestrator's per-tick read: the derived sections only — counts,
 * milestone gates, human-blocked tickets, surfaced failures, queue depth, the
 * slot ledger, anomalies — never the node and edge lists, which don't fit a
 * scheduling decision and don't fit a context window.
 */
export function toSummaryXml(
  graph: DerivedGraph,
  queue: {
    available: number;
    resume: number;
    verify: number;
    finalize: number;
    retry: number;
    liveClaims: number;
  },
  slots: {max: number; held: {agent: string; live: boolean}[]}
): string {
  const live = slots.held.filter((slot) => slot.live).length;
  // The orchestrator's exit condition, computed here so no consumer re-derives
  // it: every non-partial project terminal, nothing queued in any pass, no
  // live claim (work or review lock) still owned, and no milestone gate still
  // awaiting its review.
  const terminal =
    graph.counts.every((count) => count.partial || count.terminal) &&
    queue.available +
      queue.resume +
      queue.verify +
      queue.finalize +
      queue.retry ===
      0 &&
    queue.liveClaims === 0 &&
    graph.milestones.every(
      (milestone) => !milestone.readyForReview || milestone.reviewRecorded
    );
  const out: string[] = [`<summary terminal="${String(terminal)}">`];

  out.push('  <counts>');
  for (const count of graph.counts) {
    out.push(
      `    <project id="${attr(count.project)}" partial="${String(count.partial)}" total="${String(count.total)}" available="${String(count.available)}" blocked="${String(count.blocked)}" human-blocked="${String(count.humanBlocked)}" in-flight="${String(count.inFlight)}" dormant="${String(count.dormant)}" verified="${String(count.verified)}" canceled="${String(count.canceled)}" terminal="${String(count.terminal)}"/>`
    );
  }
  out.push('  </counts>');

  out.push(
    `  <queue available="${String(queue.available)}" resume="${String(queue.resume)}" verify="${String(queue.verify)}" finalize="${String(queue.finalize)}" retry="${String(queue.retry)}" live-claims="${String(queue.liveClaims)}"/>`
  );
  out.push(
    `  <slots max="${String(slots.max)}" held="${String(live)}" free="${String(Math.max(0, slots.max - live))}"/>`
  );

  out.push('  <milestones>');
  for (const milestone of graph.milestones) {
    out.push(`    ${milestoneXml(milestone)}`);
  }
  out.push('  </milestones>');

  out.push('  <human-blocked>');
  for (const entry of graph.humanBlocked) {
    out.push(
      `    <ticket id="${attr(entry.node.id)}" url="${attr(entry.node.url)}" role="${attr(entry.node.role)}" reason="${attr(humanReason(entry))}"/>`
    );
  }
  out.push('  </human-blocked>');

  out.push('  <failures>');
  for (const entry of graph.nodes) {
    if (entry.outcome?.outcome !== 'failed' || entry.outcome.retryable === true)
      continue;
    out.push(
      `    <ticket id="${attr(entry.node.id)}" url="${attr(entry.node.url)}" retryable="false">${text(entry.outcome.detail ?? '')}</ticket>`
    );
  }
  out.push('  </failures>');

  out.push('  <anomalies>');
  for (const anomaly of graph.anomalies) {
    out.push(
      `    <anomaly kind="${attr(anomaly.kind)}" nodes="${attr(anomaly.nodes.join(','))}">${text(anomaly.detail)}</anomaly>`
    );
  }
  out.push('  </anomalies>');

  out.push('</summary>');
  return out.join('\n');
}

function nodeXml(entry: ClassifiedNode): string {
  const {node} = entry;

  const attrs = [
    `id="${attr(node.id)}"`,
    `project="${attr(node.project)}"`,
    `url="${attr(node.url)}"`,
    `role="${attr(node.role)}"`,
    `group="${attr(GROUP_OF[node.role])}"`,
    `milestone="${attr(node.milestone ?? '')}"`,
    `target-kind="${attr(node.targetKind)}"`,
    `human-interactive="${String(node.humanInteractive)}"`,
    `effective-blocked="${String(entry.effectiveBlocked)}"`,
    `state="${attr(entry.classification)}"`,
  ];
  if (node.branchHint !== null)
    attrs.push(`branch-hint="${attr(node.branchHint)}"`);
  if (entry.claim !== null) {
    attrs.push(`claimed-by="${attr(entry.claim.agent)}"`);
    attrs.push(`claim-live="${String(entry.claim.live)}"`);
    if (entry.claim.worktree !== null)
      attrs.push(`claim-worktree="${attr(entry.claim.worktree)}"`);
    if (entry.claim.branch !== null)
      attrs.push(`claim-branch="${attr(entry.claim.branch)}"`);
  }
  if (entry.outcome !== null) {
    attrs.push(`outcome="${attr(entry.outcome.outcome)}"`);
    if (entry.outcome.retryable !== null)
      attrs.push(`outcome-retryable="${String(entry.outcome.retryable)}"`);
  }

  const labels = node.labels
    .map((label) => `<label>${text(label)}</label>`)
    .join('');
  const open = `    <node ${attrs.join(' ')}`;
  return labels === '' ? `${open}/>` : `${open}>${labels}</node>`;
}

function humanReason(entry: ClassifiedNode): string {
  return entry.node.humanInteractive || entry.node.targetKind === 'human-only'
    ? 'explicit'
    : 'parked';
}

function branchAttr(entry: ClassifiedNode): string {
  return entry.node.branchHint === null
    ? ''
    : ` branch-hint="${attr(entry.node.branchHint)}"`;
}

/** Escape a value for an XML attribute. */
export function attr(value: string): string {
  return text(value).replace(/"/g, '&quot;');
}

function text(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
