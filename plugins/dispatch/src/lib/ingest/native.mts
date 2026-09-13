import type {Database} from '../db/database.mts';
import {createLinearClient, hasLinearToken} from '../linear/index.mts';
import type {LinearClient} from '../linear/index.mts';
import type {Logger} from '../logger/index.mts';
import type {
  FetchRequest,
  ScanPayload,
  TicketPayload,
} from '../stores/index.mts';
import {
  LINEAR_SOURCE,
  ingestLinearScan,
  ingestLinearTicket,
} from './linear-ingest.mts';

/**
 * Whether the server holds a code path for this tracker and the credentials to
 * use it. False means the instruction goes to the build-graph agent, which is
 * the only path for a tracker with no client here.
 */
export function canAnswerNatively(
  source: string,
  env: NodeJS.ProcessEnv
): boolean {
  return source === LINEAR_SOURCE && hasLinearToken(env);
}

/**
 * Answer one fetch instruction in-process, reporting whether it was answered.
 *
 * A `false` leaves the request exactly as it was found, so the caller pushes
 * the instruction and the agent answers it instead. Every failure lands there:
 * a tracker with no client, an absent key, a Linear outage, or a workflow state
 * no table here maps. That last one is the reason this swallows rather than
 * propagates — the agent can ask about an unmapped state on the ticket, and
 * this cannot.
 *
 * Writes are idempotent upserts, so a fetch that fails halfway costs the agent
 * nothing beyond rewriting what was already written.
 */
export interface NativeAnswerInput {
  readonly db: Database;
  readonly request: FetchRequest;
  readonly env: NodeJS.ProcessEnv;
  readonly log?: Logger | undefined;
  readonly signal?: AbortSignal | undefined;
  /** A client to read through; the server builds its own from the environment. */
  readonly client?: LinearClient;
}

/** What a caller substitutes to answer a tracker this module does not hold. */
export type NativeAnswer = (input: NativeAnswerInput) => Promise<boolean>;

export async function answerNatively(
  input: NativeAnswerInput
): Promise<boolean> {
  const {request} = input;
  if (!canAnswerNatively(request.source, input.env)) return false;
  try {
    const client = input.client ?? createLinearClient(input.env);
    if (request.kind === 'scan_project') {
      const payload = request.payload as ScanPayload;
      await ingestLinearScan({
        db: input.db,
        client,
        projects: payload.projects,
        cursor: payload.cursor,
        signal: input.signal,
      });
    } else {
      const {ticket} = request.payload as TicketPayload;
      await ingestLinearTicket({
        db: input.db,
        client,
        ticket,
        signal: input.signal,
      });
    }
    return true;
  } catch (error) {
    input.log?.error(
      'native ingest failed; handing the instruction to an agent',
      {
        source: request.source,
        kind: request.kind,
        error: error instanceof Error ? error.message : String(error),
      }
    );
    return false;
  }
}
