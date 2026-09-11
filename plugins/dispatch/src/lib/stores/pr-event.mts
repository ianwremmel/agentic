import type {Database} from '../db/database.mts';
import {assertInstant} from '../db/time.mts';
import type {ObservationKind} from '../watch/diff.mts';
import {findNode} from './materialize.mts';

/* eslint-disable @typescript-eslint/require-await --
 * Async facade over synchronous `node:sqlite`; see `../db/database.mts`. */

export interface PendingEvent {
  readonly id: number;
  readonly node: string;
  readonly kind: ObservationKind;
  readonly summary: string;
  readonly meta: Readonly<Record<string, string>>;
  readonly observedAt: string;
}

/**
 * Observations the poll took and the session has not yet been told about.
 *
 * They outlive the tick that produced them: a push into a channel nobody is
 * listening to would otherwise lose the one notice a waiting worker gets, and
 * unlike a fetch instruction there is no later poll that re-derives it — the
 * next snapshot compares against the state that already includes the change.
 * So delivery is recorded, and a restart re-pushes what was never marked.
 */
export class PrEventStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  /**
   * Undelivered observations this session may push, oldest first.
   *
   * Scoped to the session that armed the wait: several servers share one
   * graph DB, and only the session whose worker holds the PR can route the
   * event to it. A row with no session is drainable by any — it belongs to a
   * wait armed outside a server. So is a row whose session is gone: the worker
   * it named died with it, and a watch outlives its session often enough that
   * holding the row would strand the last notice of every wait a restart
   * interrupted.
   */
  async undelivered(session: string, limit = 50): Promise<PendingEvent[]> {
    return this.#db
      .all(
        `SELECT e.id, n.external_id AS node, e.kind, e.summary, e.meta, e.observed_at
         FROM pr_event e JOIN node n ON n.id = e.node_id
         WHERE e.delivered_at IS NULL
           AND (e.session_id IS NULL OR e.session_id = ?
                OR NOT EXISTS (SELECT 1 FROM session s WHERE s.id = e.session_id))
         ORDER BY e.id
         LIMIT ?`,
        [session, limit]
      )
      .map((row) => ({
        id: Number(row.id),
        node: String(row.node),
        kind: row.kind as ObservationKind,
        summary: String(row.summary),
        meta: JSON.parse(String(row.meta)) as Record<string, string>,
        observedAt: String(row.observed_at),
      }));
  }

  /**
   * Claim an event for delivery. True from exactly one caller: a session-NULL
   * event is drainable by any server, and select-then-mark would let two of
   * them push the same tracker transition — which a session then acts on
   * twice. The claim is the conditional write, so push only after it.
   */
  async markDelivered(id: number, at: string): Promise<boolean> {
    assertInstant(at, 'at');
    return (
      this.#db.run(
        'UPDATE pr_event SET delivered_at = ? WHERE id = ? AND delivered_at IS NULL',
        [at, id]
      ) > 0
    );
  }

  /**
   * Drop a node's events. Called when its outcome lands: the item concluded,
   * so anything still owed describes a wait that no longer exists.
   */
  async clear(node: string): Promise<number> {
    const found = findNode(this.#db, node);
    if (found === null) return 0;
    return this.#db.run('DELETE FROM pr_event WHERE node_id = ?', [found.id]);
  }
}

/* eslint-enable @typescript-eslint/require-await */
