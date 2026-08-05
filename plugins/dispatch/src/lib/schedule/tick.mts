import {nowIso} from '../db/time.mts';
import {withDatabase} from '../db/index.mts';
import type {ChannelSink} from '../mcp/channel.mts';
import {drainInstructions} from '../mcp/drain.mts';
import type {Logger} from '../logger/index.mts';
import {SessionStore} from '../stores/index.mts';
import {Scheduler} from './scheduler.mts';
import type {WorkOrder} from './scheduler.mts';

/** First probe retry delay; doubles per unanswered probe up to the cap. */
const PROBE_DELAY_MS = 5_000;
const PROBE_DELAY_CAP_MS = 60_000;

export interface TickState {
  readonly registryId: string;
  readonly maxParallel?: number | undefined;
  probeDelayMs: number;
  probeDueAtMs: number;
  /** The session's row was retired; scheduling stops for good. */
  retired: boolean;
}

export function createTickState(
  registryId: string,
  maxParallel?: number
): TickState {
  return {
    registryId,
    maxParallel,
    probeDelayMs: PROBE_DELAY_MS,
    probeDueAtMs: 0,
    retired: false,
  };
}

/**
 * One server tick: heartbeat and schedule, deliver owed ingest instructions,
 * push the resulting work orders, and keep the acknowledgement handshake
 * alive — an unanswered probe re-pushes on a capped backoff rather than
 * latching a verdict. Runs on the timer and after every tool call.
 *
 * The drain waits on the acknowledgement just as orders do: an instruction
 * pushed into a channel the runner silently refused would be marked
 * delivered while nobody heard it, stranding the refresh. Until the ack
 * lands, the rows stay undelivered for `dispatch tick` to print.
 */
export async function runServerTick(
  channel: ChannelSink,
  env: NodeJS.ProcessEnv,
  state: TickState,
  opts: {nowMs?: number; log?: Logger} = {}
): Promise<void> {
  if (state.retired) return;
  const now = nowIso();
  const nowMs = opts.nowMs ?? Date.now();

  let orders: WorkOrder[] = [];
  let acked = false;
  await withDatabase(undefined, env, async (db) => {
    const scheduler = new Scheduler(db, {
      session: state.registryId,
      maxParallel: state.maxParallel,
    });
    const result = await scheduler.tick(now);
    if (result.retired) {
      state.retired = true;
      return;
    }
    orders = result.orders;

    const own = await new SessionStore(db).getSession(state.registryId);
    if (own !== null && own.ackedAt === null && nowMs >= state.probeDueAtMs) {
      channel.push(
        'probe',
        {server: state.registryId},
        `Run \`dispatch mcp ack --server ${state.registryId}\` (the \`mcp_ack\` tool) to acknowledge this channel; work orders wait on it.`
      );
      state.probeDueAtMs = nowMs + state.probeDelayMs;
      state.probeDelayMs = Math.min(state.probeDelayMs * 2, PROBE_DELAY_CAP_MS);
    }
    acked = own !== null && own.ackedAt !== null;
  });
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- the withDatabase callback above sets `state.retired`; the analyzer cannot see the closure write
  if (state.retired) return;

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- the withDatabase callback above assigns `acked`; the analyzer cannot see the closure write
  if (acked) {
    try {
      await drainInstructions(channel, env);
    } catch (error) {
      // A drain failure must not cost this tick's already-claimed orders;
      // the rows stay undelivered and the next tick retries.
      opts.log?.error('channel drain failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  for (const order of orders) {
    channel.push(order.kind, order.meta, order.body);
  }
}
