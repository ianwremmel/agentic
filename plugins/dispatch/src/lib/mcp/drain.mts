import {nowIso} from '../db/time.mts';
import {withDatabase} from '../db/index.mts';
import {FetchRequestStore, RefreshStore} from '../stores/index.mts';
import type {ScanPayload, TicketPayload} from '../stores/index.mts';
import type {ChannelWriter} from './channel.mts';

/**
 * Push every instruction the graph owes the session, then every completion.
 * Returns how many events went out. Delivery is recorded in the database, so a
 * restart re-derives what is still owed rather than assuming a push landed.
 */
export async function drainInstructions(
  channel: ChannelWriter,
  env: NodeJS.ProcessEnv,
  now: () => string = nowIso
): Promise<number> {
  return withDatabase(undefined, env, async (db) => {
    const requests = new FetchRequestStore(db);
    const refreshes = new RefreshStore(db);
    const at = now();
    let sent = 0;

    for (const request of await requests.undelivered()) {
      if (request.kind === 'scan_project') {
        const payload = request.payload as ScanPayload;
        channel.push(
          'scan_project',
          {
            tracker: request.source,
            projects: payload.projects.join(','),
            cursor: payload.cursor,
          },
          scanBody(request.source, payload)
        );
      } else {
        const {ticket} = request.payload as TicketPayload;
        channel.push(
          'fetch_ticket',
          {tracker: request.source, ticket},
          ticketBody(request.source, ticket)
        );
      }
      await requests.markDelivered(request.id, at);
      sent += 1;
    }

    for (const source of await refreshes.pendingCompletions()) {
      channel.push(
        'refresh_complete',
        {tracker: source},
        `The ${source} project graph is complete. Stop fetching and report it built.`
      );
      await refreshes.markCompletionEmitted(source, at);
      sent += 1;
    }

    return sent;
  });
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
