import type {ClassifiedNode, DerivedGraph} from './derive.mts';
import {GROUP_OF} from './roles.mts';

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
    out.push(
      `    <ticket id="${attr(entry.node.id)}" rank="${String(index + 1)}" target-kind="${attr(entry.node.targetKind)}" url="${attr(entry.node.url)}"${branchAttr(entry)}/>`
    );
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
    out.push(
      `    <milestone id="${attr(milestone.id)}" project="${attr(milestone.project)}" name="${attr(milestone.name)}" ready-for-review="${String(milestone.readyForReview)}" review-recorded="${String(milestone.reviewRecorded)}" open="${String(milestone.openCount)}" total="${String(milestone.memberCount)}" verified="${String(milestone.verified)}" canceled="${String(milestone.canceled)}" in-flight="${String(milestone.inFlight)}" blocked="${String(milestone.blocked)}" fingerprint="${attr(milestone.fingerprint)}"/>`
    );
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

function attr(value: string): string {
  return text(value).replace(/"/g, '&quot;');
}

function text(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
