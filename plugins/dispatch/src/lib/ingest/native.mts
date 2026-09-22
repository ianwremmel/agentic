import type {Database} from '../db/database.mts';
import {DispatchError} from '../errors/index.mts';
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

/**
 * Answer one fetch instruction in-process, reporting whether it was answered.
 *
 * A `false` sends the caller to the agent path. Every failure lands there: a
 * tracker with no client, an absent key, a Linear outage, or a workflow state
 * no table here maps. That last one is why this swallows rather than propagates
 * — the agent can ask about an unmapped state on the ticket, and this cannot.
 *
 * A `false` says nothing about how much was written first. Each store write is
 * its own transaction, so a failure part-way leaves what came before it
 * committed; the agent re-reads the same tracker and rewrites over it. What a
 * `false` does not claim is that the request is still open — the caller checks
 * that itself, because a failure after the request was resolved must not put a
 * finished instruction back on the wire.
 */
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
        // The hint is the half that says what to do about it — an unmapped
        // state names itself here and nowhere else, since the instruction the
        // agent then gets is the generic one.
        ...(error instanceof DispatchError ? {hint: error.hint} : {}),
      }
    );
    return false;
  }
}
