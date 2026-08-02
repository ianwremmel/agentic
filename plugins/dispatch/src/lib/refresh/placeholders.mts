import type {Database} from '../db/database.mts';

/**
 * Every node an edge referenced that nobody has since written, grouped by the
 * tracker that owns it. A placeholder carries no project of its own, so its
 * tracker comes from a ticket on the other end of an edge touching it — the
 * only thing that can have referenced it.
 *
 * One query for the whole graph rather than one per placeholder: `reconcile`
 * runs on every write, and a project scan leaves hundreds of placeholders, each
 * of which would otherwise pay this four-way join.
 *
 * A placeholder that no edge connects to a project with a tracker is absent
 * from the result — `edge add A B` with neither endpoint written yet reaches no
 * project, so there is nobody to ask. Those surface through the anomalies
 * read-model, not from here.
 */
export function placeholdersBySource(db: Database): Map<string, string[]> {
  const bySource = new Map<string, string[]>();
  const rows = db.all(
    `SELECT n.id AS id, n.external_id AS external_id, p.source AS source
     FROM node n
     JOIN edge e ON (e.blocker = n.id OR e.blocked = n.id)
     JOIN ticket t
       ON t.node_id = (CASE WHEN e.blocker = n.id THEN e.blocked ELSE e.blocker END)
     JOIN project p ON p.node_id = t.project_id
     WHERE n.kind = 'unknown' AND p.source IS NOT NULL
     GROUP BY n.id
     ORDER BY n.id`
  );
  for (const row of rows) {
    const source = String(row.source);
    const ids = bySource.get(source);
    if (ids === undefined) bySource.set(source, [String(row.external_id)]);
    else ids.push(String(row.external_id));
  }
  return bySource;
}
