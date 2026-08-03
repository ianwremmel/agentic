/* eslint-disable @typescript-eslint/require-await --
 * `node:sqlite` is synchronous; the async facade keeps call sites stable. */
import type {Database} from '../db/database.mts';
import {integer, splitList, text} from './rows.mts';
import type {Anomaly} from './types.mts';

/**
 * What the writes could not prevent. Kind conflicts, self-edges, cycles, and
 * malformed timestamps are rejected at write time; what remains is global
 * structure no single write can judge:
 *
 * - a placeholder edge endpoint — the node was never written (a fetch that
 *   resolved `missing`, or an ingest that never completed);
 * - two projects that block each other, so neither can finish first;
 * - a cycle, as a safety net for a hand-edited or imported database.
 */
export async function anomalies(db: Database): Promise<Anomaly[]> {
  const out: Anomaly[] = [];

  const cycleNodes = db
    .all(
      `WITH RECURSIVE reach(target, id) AS (
         SELECT blocker, blocked FROM edge
         UNION
         SELECT r.target, e.blocked FROM reach r JOIN edge e ON e.blocker = r.id
       )
       SELECT DISTINCT n.external_id AS id
       FROM reach r JOIN node n ON n.id = r.target
       WHERE r.target = r.id
       ORDER BY id`
    )
    .map((row) => text(row.id) ?? '');
  if (cycleNodes.length > 0) {
    out.push({
      kind: 'cycle',
      nodes: cycleNodes,
      detail: `dependency cycle through ${cycleNodes.join(', ')}; the CLI refuses cycle-closing edges, so this database was edited by something else — remove an edge to break the loop`,
    });
  }

  for (const row of db.all(
    `SELECT nb.external_id AS blocker, nb.kind AS blocker_kind,
            nd.external_id AS blocked
     FROM edge e
     JOIN node nb ON nb.id = e.blocker
     JOIN node nd ON nd.id = e.blocked
     WHERE nb.kind = 'unknown' OR nd.kind = 'unknown'
     ORDER BY blocker, blocked`
  )) {
    const blocker = text(row.blocker) ?? '';
    const blocked = text(row.blocked) ?? '';
    out.push({
      kind: 'dangling-edge',
      nodes: [blocker, blocked],
      detail:
        text(row.blocker_kind) === 'unknown'
          ? `blocker ${blocker} of ${blocked} is not in the graph; ${blocked} is held blocked until ${blocker} is written or the edge is removed`
          : `${blocker} blocks ${blocked}, which is not in the graph; the edge schedules nothing — write ${blocked} if it is in scope`,
    });
  }

  const pairs = db.all(
    `WITH pe(a, b) AS (
       SELECT DISTINCT tb.project_id, td.project_id
       FROM edge e
       JOIN ticket tb ON tb.node_id = e.blocker
       JOIN ticket td ON td.node_id = e.blocked
       WHERE tb.project_id <> td.project_id
     )
     SELECT x.a AS a_id, x.b AS b_id,
            pa.external_id AS a, pb.external_id AS b
     FROM pe x
     JOIN pe y ON y.a = x.b AND y.b = x.a
     JOIN node pa ON pa.id = x.a
     JOIN node pb ON pb.id = x.b
     WHERE x.a < x.b
     ORDER BY a, b`
  );
  for (const pair of pairs) {
    const involved = db
      .all(
        `SELECT group_concat(id, ',') AS ids FROM (
           SELECT DISTINCT n.external_id AS id
           FROM edge e
           JOIN ticket tb ON tb.node_id = e.blocker
           JOIN ticket td ON td.node_id = e.blocked
           JOIN node n ON n.id = e.blocker OR n.id = e.blocked
           WHERE (tb.project_id = ? AND td.project_id = ?)
              OR (tb.project_id = ? AND td.project_id = ?)
           ORDER BY id
         )`,
        [
          integer(pair.a_id),
          integer(pair.b_id),
          integer(pair.b_id),
          integer(pair.a_id),
        ]
      )
      .flatMap((row) => splitList(row.ids));
    out.push({
      kind: 'cross-project-reverse',
      nodes: involved,
      detail: `projects ${text(pair.a) ?? ''} and ${text(pair.b) ?? ''} block each other; neither can be completed first`,
    });
  }

  return out;
}

/* eslint-enable @typescript-eslint/require-await */
