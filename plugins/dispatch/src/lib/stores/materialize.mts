import type {Database} from '../db/database.mts';
import {DataError, ensure} from '../errors/index.mts';
import type {ConcreteKind, Kind} from '../model/status.mts';

export interface NodeRow {
  id: number;
  kind: Kind;
}

export function findNode(db: Database, externalId: string): NodeRow | null {
  const row = db.get('SELECT id, kind FROM node WHERE external_id = ?', [
    externalId,
  ]);
  if (row === undefined) return null;
  return {id: Number(row.id), kind: row.kind as Kind};
}

/** The node for an id, creating an `unknown` placeholder when nobody wrote it. */
export function nodeRef(db: Database, externalId: string): number {
  const existing = findNode(db, externalId);
  if (existing !== null) return existing.id;
  db.run("INSERT INTO node (external_id, kind) VALUES (?, 'unknown')", [
    externalId,
  ]);
  const created = findNode(db, externalId);
  ensure(
    created !== null,
    () => new DataError('a node just inserted must exist')
  );
  return created.id;
}

/**
 * The node for a satellite being written: created with its kind, or promoted
 * from a placeholder. Any kind may block any other, so promotion has no edge
 * legality to check — only that the id is not already the *other* concrete kind.
 */
export function materialize(
  db: Database,
  externalId: string,
  kind: ConcreteKind
): number {
  const existing = findNode(db, externalId);
  if (existing === null) {
    db.run('INSERT INTO node (external_id, kind) VALUES (?, ?)', [
      externalId,
      kind,
    ]);
    const created = findNode(db, externalId);
    ensure(
      created !== null,
      () => new DataError('a node just inserted must exist')
    );
    return created.id;
  }
  if (existing.kind === kind) return existing.id;
  ensure(
    existing.kind === 'unknown',
    () =>
      new DataError(
        `id "${externalId}" is already a ${existing.kind}; it cannot also be a ${kind}`,
        {
          hint: `entities share one id space — give the ${kind} a different id, or remove the ${existing.kind} first.`,
        }
      )
  );
  db.run('UPDATE node SET kind = ? WHERE id = ?', [kind, existing.id]);
  return existing.id;
}
