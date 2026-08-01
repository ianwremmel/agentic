import type {Database} from '../db/database.mts';
import {DataError, ensure} from '../errors/index.mts';
import {assertInstant} from '../db/time.mts';

/* eslint-disable @typescript-eslint/require-await --
 * Async facade over synchronous `node:sqlite`; see `../db/database.mts`. */

export const FETCH_KINDS = ['scan_project', 'fetch_ticket'] as const;
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

  async undelivered(): Promise<FetchRequest[]> {
    return this.#db
      .all(
        `SELECT ${COLUMNS} FROM fetch_request
         WHERE delivered_at IS NULL AND resolution IS NULL
         ORDER BY id`
      )
      .map(toRequest);
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
       WHERE kind = 'fetch_ticket' AND resolution IS NULL AND payload = ?`,
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
   * row: nothing ever resolves it, and a refresh in `scanning` is already held
   * open by its state. Counting it would mean no refresh ever closes.
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
 * Database values are known to be primitives; avoid as-casts per brief. */
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
