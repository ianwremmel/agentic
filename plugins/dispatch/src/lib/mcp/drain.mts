import {nowIso} from '../db/time.mts';
import {withDatabase} from '../db/index.mts';
import {answerNatively} from '../ingest/index.mts';
import type {NativeAnswer} from '../ingest/index.mts';
import type {Logger} from '../logger/index.mts';
import {FetchRequestStore, RefreshStore} from '../stores/index.mts';
import type {
  FetchRequest,
  ScanPayload,
  TicketPayload,
} from '../stores/index.mts';
import type {ChannelWriter} from './channel.mts';

/**
 * The bound on answering instructions that enqueue further instructions. A
 * scan's placeholders are asked for as a batch, and each batch can reference
 * one more, so the depth is the dependency chain's — never this deep, and
 * bounded anyway so a pathological graph cannot hold the read loop.
 */
const MAX_PASSES = 10;

export interface DrainOptions {
  readonly now?: () => string;
  readonly log?: Logger | undefined;
  /**
   * How an instruction is answered in-process. The drain knows nothing about
   * any tracker: it asks, and pushes whatever comes back unanswered.
   */
  readonly answer?: NativeAnswer;
}

/**
 * Push every instruction the graph owes the session, then every completion.
 * Returns how many events went out. Delivery is recorded in the database, so a
 * restart re-derives what is still owed rather than assuming a push landed.
 *
 * An instruction the server can answer itself — a tracker it holds a client for,
 * with the credentials to use it — is answered here instead of pushed, and
 * nothing goes out for it. Everything else, that path's failures included, is
 * pushed to the session for an agent to answer.
 */
export async function drainInstructions(
  channel: ChannelWriter,
  env: NodeJS.ProcessEnv,
  options: DrainOptions = {}
): Promise<number> {
  const now = options.now ?? nowIso;
  const answer = options.answer ?? answerNatively;
  return withDatabase(undefined, env, async (db) => {
    const requests = new FetchRequestStore(db);
    const refreshes = new RefreshStore(db);
    let sent = 0;

    // Re-read rather than snapshot: answering a scan here enqueues asks for the
    // placeholders it referenced, and those are owed in this drain too.
    for (let pass = 0; pass < MAX_PASSES; pass += 1) {
      const pending = await requests.undelivered();
      if (pending.length === 0) break;
      let answered = 0;
      for (const request of pending) {
        if (await answer({db, request, env, log: options.log})) {
          answered += 1;
          continue;
        }
        channel.push(...instruction(request));
        await requests.markDelivered(request.id, now());
        sent += 1;
      }
      // Only a native answer can add to the queue; a pushed one is marked
      // delivered and cannot come back.
      if (answered === 0) break;
    }

    for (const source of await refreshes.pendingCompletions()) {
      channel.push(
        'refresh_complete',
        {tracker: source},
        `The ${source} project graph is complete. Stop fetching and report it built.`
      );
      await refreshes.markCompletionEmitted(source, now());
      sent += 1;
    }

    return sent;
  });
}

/** One request as the event that asks an agent to answer it. */
function instruction(
  request: FetchRequest
): [string, Record<string, string | null>, string] {
  if (request.kind === 'scan_project') {
    const payload = request.payload as ScanPayload;
    return [
      'scan_project',
      {
        tracker: request.source,
        projects: payload.projects.join(','),
        cursor: payload.cursor,
      },
      scanBody(request.source, payload),
    ];
  }
  const {ticket} = request.payload as TicketPayload;
  if (request.kind === 'fetch_ticket') {
    return [
      'fetch_ticket',
      {tracker: request.source, ticket},
      ticketBody(request.source, ticket),
    ];
  }
  return [
    'refresh_ticket',
    {tracker: request.source, ticket},
    `Re-fetch ticket ${ticket} from ${request.source} and record it with dispatch ticket set — the graph's copy may be stale. If ${request.source} no longer has it, run: dispatch ticket missing --id ${ticket}`,
  ];
}

function scanBody(source: string, payload: ScanPayload): string {
  const since =
    payload.cursor === null ? '' : ` updated since ${payload.cursor}`;
  return [
    `Scan every ticket in ${payload.projects.join(', ')} on ${source}${since}.`,
    'Record each project, milestone, ticket, and dependency with the dispatch',
    `commands, then run: dispatch refresh done --tracker ${source} --cursor <token>`,
  ].join(' ');
}

function ticketBody(source: string, ticket: string): string {
  return [
    `Fetch ticket ${ticket} from ${source} and record it with dispatch ticket set.`,
    `If ${source} has no such ticket, run: dispatch ticket missing --id ${ticket}`,
  ].join(' ');
}
