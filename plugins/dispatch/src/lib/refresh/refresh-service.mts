import type {Database} from '../db/database.mts';
import {nowIso} from '../db/time.mts';
import {ensure, UsageError} from '../errors/index.mts';
import {
  CursorStore,
  FetchRequestStore,
  findNode,
  RefreshStore,
} from '../stores/index.mts';
import type {FetchRequest, RefreshRow, RefreshState} from '../stores/index.mts';
import {sourceForPlaceholder, unknownNodeIds} from './placeholders.mts';

/**
 * Every decision about what to fetch next and when a refresh is done. All of it
 * derives from the database, so `reconcile` is idempotent and a write command
 * can call it unconditionally without knowing which phase it is in.
 */
export class RefreshService {
  readonly #db: Database;
  readonly #refreshes: RefreshStore;
  readonly #requests: FetchRequestStore;
  readonly #cursors: CursorStore;
  readonly #now: () => string;

  constructor(db: Database, now: () => string = nowIso) {
    this.#db = db;
    this.#refreshes = new RefreshStore(db);
    this.#requests = new FetchRequestStore(db);
    this.#cursors = new CursorStore(db);
    this.#now = now;
  }

  /** Open a refresh, or report that a live one already owns this source. */
  async startScan(input: {
    source: string;
    projects: readonly string[];
    sessionId: string | null;
    rebuild: boolean;
  }): Promise<{resumed: boolean}> {
    const row = await this.#refreshes.get(input.source);
    // A refresh that closed but has not yet had its completion pushed still
    // belongs to whoever is waiting on that event — reopening it here would
    // blank the completion fields and the event would never fire.
    const finishing =
      row !== null &&
      row.completedAt !== null &&
      row.completionEmittedAt === null;
    const busy = row !== null && (row.state !== 'idle' || finishing);
    if (busy && (await this.#refreshes.hasLiveSession(input.source))) {
      return {resumed: true};
    }

    if (input.rebuild) {
      await this.#db.transaction(() => this.#db.run('DELETE FROM node'));
      // The delete is graph-wide, so every source's cursor must reset with it —
      // otherwise another tracker's next delta sync starts past data that no
      // longer exists and never re-fetches it.
      await this.#cursors.clearAllCursors();
    }

    const at = this.#now();
    await this.#requests.clear(input.source);
    await this.#refreshes.open({
      source: input.source,
      projects: input.projects,
      sessionId: input.sessionId,
      at,
    });
    const cursor = await this.#cursors.getCursor(input.source);
    await this.#requests.enqueueScan({
      source: input.source,
      projects: input.projects,
      cursor,
      at,
    });
    return {resumed: false};
  }

  /** The agent has written everything its scan found. */
  async completeScan(input: {
    source: string;
    cursor: string | null;
  }): Promise<{state: RefreshState; pending: string[]}> {
    const row = await this.#refreshes.get(input.source);
    ensure(
      row !== null && row.state === 'scanning',
      () =>
        new UsageError(`no scan is in progress for ${input.source}`, {
          hint: 'start one with `dispatch refresh --tracker <id> --project <id>` before reporting it done.',
        })
    );

    if (input.cursor !== null) {
      await this.#refreshes.setPendingCursor(input.source, input.cursor);
    }
    await this.#refreshes.setState(input.source, 'resolving');
    await this.reconcile();

    const after = await this.#refreshes.get(input.source);
    const pending = (await this.#requests.openTickets())
      .filter((request) => request.source === input.source)
      .map((request) => request.ticket);
    return {state: after?.state ?? 'idle', pending};
  }

  /** The tracker has no such ticket; stop asking for it. */
  async markMissing(ticket: string): Promise<void> {
    const request = await this.#requests.openTicketRequest(ticket);
    ensure(
      request !== null,
      () =>
        new UsageError(`nothing asked for ticket ${ticket}`, {
          hint: 'only a ticket the CLI requested can be reported missing — check `dispatch refresh status`.',
        })
    );
    await this.#requests.resolve(request.id, 'missing');
    await this.reconcile();
  }

  async status(
    source: string
  ): Promise<{refresh: RefreshRow | null; requests: FetchRequest[]}> {
    return {
      refresh: await this.#refreshes.get(source),
      requests: await this.#requests.bySource(source),
    };
  }

  /**
   * Bring every source back in line with the graph. Three passes, in order:
   * satisfy requests whose ticket now exists, chase placeholders nobody is
   * fetching, close whatever has nothing outstanding.
   */
  async reconcile(): Promise<void> {
    const at = this.#now();

    for (const request of await this.#requests.openTickets()) {
      const node = findNode(this.#db, request.ticket);
      if (node !== null && node.kind !== 'unknown') {
        await this.#requests.resolve(request.id, 'materialized');
      }
    }

    // A scan writes edges before their endpoints, so under one every reference
    // is briefly dangling; chasing them there would ask for most of the project.
    for (const externalId of unknownNodeIds(this.#db)) {
      const source = sourceForPlaceholder(this.#db, externalId);
      if (source === null) continue;
      const row = await this.#refreshes.get(source);
      if (row?.state === 'scanning') continue;
      // A refresh that closed but still owes its completion push is not fair
      // game to reopen — a placeholder markMissing deliberately left unknown
      // would otherwise erase the pending completion on every later reconcile.
      if (
        row !== null &&
        row.completedAt !== null &&
        row.completionEmittedAt === null
      ) {
        continue;
      }
      if (row === null || row.state === 'idle') {
        await this.#refreshes.openResolving({source, sessionId: null, at});
      }
      await this.#requests.enqueueTicket({source, ticket: externalId, at});
    }

    for (const row of await this.#refreshes.active()) {
      if (row.state !== 'resolving') continue;
      if ((await this.#requests.openCount(row.source)) > 0) continue;
      if (row.pendingCursor !== null) {
        await this.#cursors.setCursor(row.source, row.pendingCursor);
      }
      await this.#requests.clearExceptMissing(row.source);
      await this.#refreshes.close(row.source, at);
    }
  }
}
