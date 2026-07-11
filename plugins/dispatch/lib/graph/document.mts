/**
 * Writes the derived document as XML — the one artifact the orchestrator reads.
 *
 * Every scheduling decision it makes comes from the sections here, so each is
 * emitted explicitly (empty ones included). A missing section would read as
 * "nothing to do" rather than as an error.
 */

import {el, serialize, type Element} from './xml.mts';
import type {Counts, Document} from './types.mts';

const counts = (c: Counts): Element =>
  el('counts', {
    total: c.total,
    verified: c.verified,
    canceled: c.canceled,
    'permanently-blocked': c.permanently_blocked,
    remaining: c.remaining,
    terminal: c.terminal,
  });

const refs = (name: string, ids: string[]): Element =>
  el(name, {count: ids.length}, ids.map((id) => el('ticket', {id})));

/**
 * Serialize the document.
 *
 * @param doc the output of `derive`
 * @returns XML, newline-terminated
 */
export function writeDocument(doc: Document): string {
  const root = el('project-graph', {cursor: doc.cursor ?? undefined}, [
    el(
      'projects',
      {},
      doc.projects.map((p) => el('project', {id: p.id, name: p.name}, [counts(p.counts)])),
    ),
    el(
      'milestones',
      {},
      doc.milestones.map((m) =>
        el(
          'milestone',
          {
            id: m.id,
            project: m.project,
            name: m.name,
            order: m.order,
            'ready-for-review': m.ready_for_review,
            'review-recorded': m.review_recorded,
          },
          [counts(m.counts)],
        ),
      ),
    ),
    // Ranked frontier first: it is the section the orchestrator acts on.
    refs('available', doc.available),
    refs('blocked', doc.blocked),
    refs('human-blocked', doc.human_blocked),
    refs('permanently-blocked', doc.permanently_blocked),
    refs('stalled', doc.stalled),
    counts(doc.counts),
    el(
      'anomalies',
      {count: doc.anomalies.length},
      doc.anomalies.map((a) => {
        if (a.kind === 'cycle') return el('anomaly', {kind: a.kind, nodes: a.nodes.join(',')});
        if (a.kind === 'cross-project-cycle')
          return el('anomaly', {kind: a.kind, projects: a.projects.join(',')});
        if (a.kind === 'unknown-blocker')
          return el('anomaly', {kind: a.kind, node: a.node, blockers: a.blockers.join(',')});
        return el('anomaly', {kind: a.kind, node: a.node, milestone: a.milestone});
      }),
    ),
    el(
      'nodes',
      {},
      doc.nodes.map((n) =>
        el(
          'node',
          {
            id: n.id,
            url: n.url,
            title: n.title,
            role: n.role,
            project: n.project,
            milestone: n.milestone,
            'target-kind': n.target_kind,
            'branch-hint': n.branch_hint,
            'effective-blocked': n.effective_blocked,
            'milestone-gate': n.milestone_gate ?? undefined,
            'human-blocked': n.human_blocked,
            'permanently-blocked': n.permanently_blocked,
            unlocks: n.unlocks,
          },
          [
            ...n.blocked_by.map((id) => el('blocked-by', {id})),
            ...(n.pr_urls ?? []).map((url) => el('pr', {url})),
          ],
        ),
      ),
    ),
  ]);

  return `${serialize(root)}\n`;
}
