import {nowIso} from '../db/time.mts';
import {withDatabase} from '../db/index.mts';
import type {ChannelWriter} from '../mcp/channel.mts';
import {SessionStore} from '../stores/index.mts';
import {Scheduler} from './scheduler.mts';

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
 * One server tick: heartbeat and schedule, push the resulting work orders,
 * and keep the acknowledgement handshake alive — an unanswered probe re-pushes
 * on a capped backoff rather than latching a verdict. Runs on the timer and
 * after every tool call.
 */
export async function runServerTick(
  channel: ChannelWriter,
  env: NodeJS.ProcessEnv,
  state: TickState,
  nowMs = Date.now()
): Promise<void> {
  if (state.retired) return;
  const now = nowIso();

  await withDatabase(undefined, env, async (db) => {
    const scheduler = new Scheduler(db, {
      session: state.registryId,
      maxParallel: state.maxParallel,
    });
    const {orders, retired} = await scheduler.tick(now);
    if (retired) {
      state.retired = true;
      return;
    }

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

    for (const order of orders) {
      channel.push(order.kind, order.meta, order.body);
    }
  });
}
