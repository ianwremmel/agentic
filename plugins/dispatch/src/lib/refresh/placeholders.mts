import type {Database} from '../db/database.mts';

/** Every node an edge referenced that nobody has since written. */
export function unknownNodeIds(db: Database): string[] {
  return db
    .all("SELECT external_id FROM node WHERE kind = 'unknown' ORDER BY id")
    .map((row) => String(row.external_id));
}

/**
 * Which tracker a placeholder belongs to. A placeholder carries no project of
 * its own, so the tracker comes from a ticket on the other end of an edge
 * touching it — the only thing that can have referenced it.
 */
export function sourceForPlaceholder(
  db: Database,
  externalId: string
): string | null {
  const row = db.get(
    `SELECT p.source AS source
     FROM node n
     JOIN edge e ON (e.blocker = n.id OR e.blocked = n.id)
     JOIN ticket t
       ON t.node_id = (CASE WHEN e.blocker = n.id THEN e.blocked ELSE e.blocker END)
     JOIN project p ON p.node_id = t.project_id
     WHERE n.external_id = ? AND p.source IS NOT NULL
     LIMIT 1`,
    [externalId]
  );
  return row === undefined ? null : String(row.source);
}
