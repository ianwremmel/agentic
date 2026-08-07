import type {Database} from '../db/database.mts';
import {DataError, ensure} from '../errors/index.mts';
import {assertInstant} from '../db/time.mts';

/* eslint-disable @typescript-eslint/require-await --
 * Async facade over synchronous `node:sqlite`; see `../db/database.mts`. */

export const FETCH_KINDS = [
  'scan_project',
  'fetch_ticket',
  'refresh_ticket',
] as const;
export type FetchKind = (typeof FETCH_KINDS)[number];
export type FetchResolution = 'materialized' | 'missing';

export interface ScanPayload {
  projects: string[];
  cursor: string | null;
}

export interface TicketPayload {
  ticket: string;
}

export interface FetchRequest {
  id: number;
  source: string;
  kind: FetchKind;
  payload: ScanPayload | TicketPayload;
  createdAt: string;
  deliveredAt: string | null;
  resolution: FetchResolution | null;
}

const COLUMNS =
  'id, source, kind, payload, created_at, delivered_at, resolution';

/**
 * The durable instruction queue. A ticket request is keyed by its serialized
 * payload, so a row that was already resolved `missing` still suppresses a
 * re-enqueue — that is what stops one dead reference restarting the loop.
 */
export class FetchRequestStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  async enqueueScan(input: {
    source: string;
    projects: readonly string[];
    cursor: string | null;
    at: string;
  }): Promise<number> {
    assertInstant(input.at, 'at');
    const payload: ScanPayload = {
      projects: [...input.projects],
      cursor: input.cursor,
    };
    return this.#insert(
      input.source,
      'scan_project',
      JSON.stringify(payload),
      input.at
    );
  }

  /**
   * Enqueue a ticket request. The existence check and insert execute atomically in a
   * transaction to prevent two processes racing past the check and both inserting for
   * the same ticket. The check deliberately matches any existing row, including one
   * already resolved `missing`, so a ticket the tracker does not have is not
   * requested again for the rest of the refresh.
   */
  async enqueueTicket(input: {
    source: string;
    ticket: string;
    at: string;
  }): Promise<number | null> {
    assertInstant(input.at, 'at');
    const payload = JSON.stringify({
      ticket: input.ticket,
    } satisfies TicketPayload);
    return this.#db.transaction(() => {
      const existing = this.#db.get(
        `SELECT id FROM fetch_request
         WHERE source = ? AND kind = 'fetch_ticket' AND payload = ?`,
        [input.source, payload]
      );
      if (existing !== undefined) return null;
      return this.#insert(input.source, 'fetch_ticket', payload, input.at);
    });
  }

  /**
   * Enqueue a recurring re-read of a ticket the graph already holds.
   *
   * A distinct kind from `fetch_ticket`, because their lifecycles differ in
   * both directions: reconcile resolves a `fetch_ticket` the moment the node
   * exists (for a re-read it always does, which would resolve it before any
   * fetch happened), and `enqueueTicket` dedupes against resolved rows for
   * the life of a refresh (which would allow exactly one re-read ever).
   * A `refresh_ticket` is resolved by `ticket set` writing the ticket, and
   * dedupes only against its own open rows — one outstanding ask per ticket.
   */
  async enqueueTicketRefresh(input: {
    source: string;
    ticket: string;
    at: string;
  }): Promise<number | null> {
    assertInstant(input.at, 'at');
    const payload = JSON.stringify({
      ticket: input.ticket,
    } satisfies TicketPayload);
    return this.#db.transaction(() => {
      const open = this.#db.get(
        `SELECT id FROM fetch_request
         WHERE source = ? AND kind = 'refresh_ticket' AND payload = ?
           AND resolution IS NULL`,
        [input.source, payload]
      );
      if (open !== undefined) return null;
      // The history's only job is carrying the newest ask time for the
      // cadence; without this, every answered ask is a permanent row and a
      // long-lived ticket accretes one per cadence forever.
      this.#db.run(
        `DELETE FROM fetch_request
         WHERE kind = 'refresh_ticket' AND payload = ? AND resolution IS NOT NULL`,
        [payload]
      );
      return this.#insert(input.source, 'refresh_ticket', payload, input.at);
    });
  }

  /**
   * Resolve every open re-read ask for a ticket, any source. Called by
   * `ticket set`: the write is the answer, whoever asked.
   */
  async resolveTicketRefresh(ticket: string): Promise<number> {
    return this.#db.run(
      `UPDATE fetch_request SET resolution = 'materialized'
       WHERE kind = 'refresh_ticket' AND resolution IS NULL AND payload = ?`,
      [JSON.stringify({ticket} satisfies TicketPayload)]
    );
  }

  /**
   * Re-offer refresh asks that were pushed but never answered. Scan-resume
   * redelivery deliberately does not own these, so without this a push the
   * session never heard (channel down, session gone) would leave the ask
   * open forever — and an open ask suppresses every future one.
   */
  async redeliverStaleTicketRefreshes(
    now: string,
    olderThanSeconds: number
  ): Promise<number> {
    assertInstant(now, 'now');
    return this.#db.run(
      `UPDATE fetch_request SET delivered_at = NULL
       WHERE kind = 'refresh_ticket' AND resolution IS NULL
         AND delivered_at IS NOT NULL
         AND unixepoch(?) - unixepoch(delivered_at) >= ?`,
      [now, olderThanSeconds]
    );
  }

  /**
   * When a ticket was last asked about via `refresh_ticket`, or null if
   * never. Drives the cadence: due = no open ask and the last one is older
   * than the interval.
   */
  async lastTicketRefreshAt(ticket: string): Promise<string | null> {
    const row = this.#db.get(
      `SELECT MAX(created_at) AS at FROM fetch_request
       WHERE kind = 'refresh_ticket' AND payload = ?`,
      [JSON.stringify({ticket} satisfies TicketPayload)]
    );
    return typeof row?.at === 'string' ? row.at : null;
  }

  async undelivered(): Promise<FetchRequest[]> {
    return this.#db
      .all(
        `SELECT ${COLUMNS} FROM fetch_request
         WHERE delivered_at IS NULL AND resolution IS NULL
         ORDER BY id`
      )
      .map(toRequest);
  }

  /**
   * Mark a source's scan instruction answered. Nothing else resolves it —
   * `openCount` ignores it, and the refresh's own state holds the scan open —
   * so without this it stays outstanding for the life of the refresh and
   * `redeliver` would put a finished scan back on the wire, whose `refresh
   * done` the CLI would then refuse for having no scan in progress.
   */
  async resolveScan(source: string): Promise<number> {
    return this.#db.run(
      `UPDATE fetch_request SET resolution = 'materialized'
       WHERE source = ? AND kind = 'scan_project' AND resolution IS NULL`,
      [source]
    );
  }

  /**
   * Offer every unresolved request for a source to the channel again by
   * clearing its delivery mark. Nothing acknowledges a channel push, so a
   * delivery mark records that the server wrote the event, not that a session
   * received it. Re-delivering costs the agent a duplicate instruction it will
   * satisfy idempotently; not re-delivering leaves it waiting on an event that
   * is already marked sent, with nothing to time it out.
   */
  async redeliver(source: string): Promise<number> {
    return this.#db.run(
      `UPDATE fetch_request SET delivered_at = NULL
       WHERE source = ? AND resolution IS NULL
         AND kind IN ('scan_project','fetch_ticket')`,
      [source]
    );
  }

  async markDelivered(id: number, at: string): Promise<void> {
    assertInstant(at, 'at');
    this.#db.run('UPDATE fetch_request SET delivered_at = ? WHERE id = ?', [
      at,
      id,
    ]);
  }

  async resolve(id: number, resolution: FetchResolution): Promise<void> {
    this.#db.run('UPDATE fetch_request SET resolution = ? WHERE id = ?', [
      resolution,
      id,
    ]);
  }

  async openTickets(): Promise<{id: number; source: string; ticket: string}[]> {
    return this.#db
      .all(
        `SELECT id, source, payload FROM fetch_request
         WHERE kind = 'fetch_ticket' AND resolution IS NULL
         ORDER BY id`
      )
      .map((row) => ({
        id: Number(row.id),
        source: String(row.source),
        ticket: (JSON.parse(String(row.payload)) as TicketPayload).ticket,
      }));
  }

  async openTicketRequest(
    ticket: string
  ): Promise<{id: number; source: string} | null> {
    const row = this.#db.get(
      `SELECT id, source FROM fetch_request
       WHERE kind IN ('fetch_ticket','refresh_ticket')
         AND resolution IS NULL AND payload = ?`,
      [JSON.stringify({ticket} satisfies TicketPayload)]
    );
    return row === undefined
      ? null
      : {id: Number(row.id), source: String(row.source)};
  }

  async bySource(source: string): Promise<FetchRequest[]> {
    return this.#db
      .all(
        `SELECT ${COLUMNS} FROM fetch_request WHERE source = ? ORDER BY id`,
        [source]
      )
      .map(toRequest);
  }

  /**
   * Outstanding ticket requests. Deliberately not counting the `scan_project`
   * row: it resolves only when the scan completes (`resolveScan`), and a
   * refresh in `scanning` is already held open by its state, so counting it
   * here would just delay the close.
   */
  async openCount(source: string): Promise<number> {
    const row = this.#db.get(
      `SELECT COUNT(*) AS n FROM fetch_request
       WHERE source = ? AND kind = 'fetch_ticket' AND resolution IS NULL`,
      [source]
    );
    return row === undefined ? 0 : Number(row.n);
  }

  async clear(source: string): Promise<number> {
    return this.#db.run('DELETE FROM fetch_request WHERE source = ?', [source]);
  }

  /**
   * Forget every request for a source except the `missing` tombstones. Those
   * are what stop a ticket the tracker does not have from being requested
   * again, so a refresh that closes must leave them behind; only an explicit
   * new scan forgets them.
   */
  async clearExceptMissing(source: string): Promise<number> {
    return this.#db.run(
      `DELETE FROM fetch_request
       WHERE source = ? AND (resolution IS NULL OR resolution <> 'missing')`,
      [source]
    );
  }

  #insert(
    source: string,
    kind: FetchKind,
    payload: string,
    at: string
  ): number {
    this.#db.run(
      `INSERT INTO fetch_request (source, kind, payload, created_at)
       VALUES (?, ?, ?, ?)`,
      [source, kind, payload, at]
    );
    // The id must be read back per-connection: several dispatch processes write this
    // table concurrently, and a table-wide "highest id" would return another process's row.
    const row = this.#db.get('SELECT last_insert_rowid() AS id');
    ensure(
      row !== undefined,
      () => new DataError('a fetch request just inserted must exist')
    );
    return Number(row.id);
  }
}

/* eslint-disable @typescript-eslint/no-base-to-string --
 * SQLite hands back `unknown`; `String()` converts a primitive rather than
 * asserting a type the row has not been checked for. */
function toRequest(row: Record<string, unknown>): FetchRequest {
  return {
    id: Number(row.id),
    source: String(row.source),
    kind: row.kind as FetchKind,
    payload: JSON.parse(String(row.payload)) as ScanPayload | TicketPayload,
    createdAt: String(row.created_at),
    deliveredAt: row.delivered_at === null ? null : String(row.delivered_at),
    resolution:
      row.resolution === null ? null : (row.resolution as FetchResolution),
  };
}
/* eslint-enable @typescript-eslint/no-base-to-string */

/* eslint-enable @typescript-eslint/require-await */
