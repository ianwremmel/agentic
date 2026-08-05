import {nowIso} from '../db/time.mts';
import {withDatabase} from '../db/index.mts';
import type {Logger} from '../logger/index.mts';
import type {ChannelWriter} from '../mcp/channel.mts';
import {PrEventStore, PrStore, SessionStore} from '../stores/index.mts';
import {githubSnapshot, pollWatches} from '../watch/index.mts';
import type {Snapshotter} from '../watch/index.mts';
import {Scheduler} from './scheduler.mts';
import type {WorkOrder} from './scheduler.mts';

/** First probe retry delay; doubles per unanswered probe up to the cap. */
const PROBE_DELAY_MS = 5_000;
const PROBE_DELAY_CAP_MS = 60_000;

export interface TickState {
  readonly registryId: string;
  readonly maxParallel?: number | undefined;
  /** The account the agent writes as; its own PR activity never wakes it. */
  readonly self?: string | null | undefined;
  probeDelayMs: number;
  probeDueAtMs: number;
  /** The session's row was retired; scheduling stops for good. */
  retired: boolean;
}

export function createTickState(
  registryId: string,
  maxParallel?: number,
  self?: string | null
): TickState {
  return {
    registryId,
    maxParallel,
    self,
    probeDelayMs: PROBE_DELAY_MS,
    probeDueAtMs: 0,
    retired: false,
  };
}

/**
 * One server tick: heartbeat and schedule, poll the PR watches, push what
 * they observed, push the resulting work orders, and keep the acknowledgement
 * handshake alive — an unanswered probe re-pushes on a capped backoff rather
 * than latching a verdict. Runs on the timer and after every tool call.
 *
 * Observations are pushed only once the channel is acked, for the same reason
 * work orders are: an event pushed into a channel the runner silently refused
 * would be marked delivered while nobody heard it. Unlike a work order there
 * is no later re-derivation — the next snapshot compares against a state that
 * already contains the change — so until the ack lands the rows wait.
 */
export async function runServerTick(
  channel: ChannelWriter,
  env: NodeJS.ProcessEnv,
  state: TickState,
  opts: {nowMs?: number; log?: Logger; snapshot?: Snapshotter} = {}
): Promise<void> {
  if (state.retired) return;
  const now = nowIso();
  const nowMs = opts.nowMs ?? Date.now();

  let orders: WorkOrder[] = [];
  let acked = false;

  const schedule = async (): Promise<void> => {
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
      orders = [...orders, ...result.orders];

      const own = await new SessionStore(db).getSession(state.registryId);
      if (own !== null && own.ackedAt === null && nowMs >= state.probeDueAtMs) {
        channel.push(
          'probe',
          {server: state.registryId},
          `Run \`dispatch mcp ack --server ${state.registryId}\` (the \`mcp_ack\` tool) to acknowledge this channel; work orders wait on it.`
        );
        state.probeDueAtMs = nowMs + state.probeDelayMs;
        state.probeDelayMs = Math.min(
          state.probeDelayMs * 2,
          PROBE_DELAY_CAP_MS
        );
      }
      acked = own !== null && own.ackedAt !== null;
    });
  };

  // Heartbeat before the watch poll: snapshotting shells out to gh, and a
  // slow pass must not let this session read as stale mid-tick.
  await schedule();
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- the schedule() closure sets `state.retired`; the analyzer cannot see the write
  if (state.retired) return;

  try {
    const {fired} = await pollWatches(env, {
      snapshot: opts.snapshot ?? githubSnapshot,
      log: opts.log,
    });
    // A fired watch re-queued its item; a second pass dispatches it in this
    // tick instead of the next. Claims make the extra pass idempotent.
    if (fired.length > 0) await schedule();
  } catch (error) {
    opts.log?.error('watch pass failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- the schedule() closure sets `state.retired`; the analyzer cannot see the write
  if (state.retired) return;

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- the schedule() closure assigns `acked`; the analyzer cannot see the write
  if (acked) {
    try {
      await pushObservations(channel, env, state.registryId, now);
    } catch (error) {
      // A push failure must not cost this tick's already-claimed orders; the
      // rows stay undelivered and the next tick retries.
      opts.log?.error('observation push failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  for (const order of orders) {
    channel.push(order.kind, order.meta, order.body);
  }
}

/**
 * Hand the session every observation the poll owes it. Each names the PR item
 * it belongs to, which is what lets the session route it to the worker
 * holding that PR rather than acting on it itself.
 */
async function pushObservations(
  channel: ChannelWriter,
  env: NodeJS.ProcessEnv,
  session: string,
  at: string
): Promise<void> {
  await withDatabase(undefined, env, async (db) => {
    const events = new PrEventStore(db);
    const prs = new PrStore(db);
    for (const event of await events.undelivered(session)) {
      const pr = await prs.getPr(event.node);
      channel.push(
        event.kind,
        {
          ...event.meta,
          item: event.node,
          ...(pr?.repo == null ? {} : {repo: pr.repo}),
          ...(pr?.prNumber == null ? {} : {pr: String(pr.prNumber)}),
        },
        `${event.summary} Re-read the PR with \`pr-status\` before acting; this names what moved, not the whole state.`
      );
      await events.markDelivered(event.id, at);
    }
  });
}
