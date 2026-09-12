import {nowIso} from '../db/time.mts';
import {withDatabase} from '../db/index.mts';
import type {Logger} from '../logger/index.mts';
import type {ChannelWriter} from '../mcp/channel.mts';
import {
  CoordinationStore,
  PrEventStore,
  PrStore,
  SessionStore,
  WatchStore,
  WorkerStore,
} from '../stores/index.mts';
import {
  adoptOrphans,
  githubSnapshot,
  pollWatches,
  renderSnapshot,
} from '../watch/index.mts';
import type {Snapshotter} from '../watch/index.mts';
import {Scheduler} from './scheduler.mts';
import type {WorkOrder} from './scheduler.mts';

/** First probe retry delay; doubles per unanswered probe up to the cap. */
const PROBE_DELAY_MS = 5_000;
const PROBE_DELAY_CAP_MS = 60_000;

export interface TickState {
  readonly registryId: string;
  readonly maxParallel?: number | undefined;
  /** Last adoption sweep; a slow cadence, since orphans are rare. */
  adoptDueAtMs: number;
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
    adoptDueAtMs: 0,
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
      if (result.ingesting.length > 0) {
        opts.log?.debug('scheduling held while the graph is being built', {
          sources: result.ingesting.join(','),
        });
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
    // A fired watch re-queued its item unless a live worker still holds it,
    // in which case the push below relays instead; a second pass dispatches
    // the queued ones in this tick rather than the next. Claims make the
    // extra pass idempotent.
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
    if (nowMs >= state.adoptDueAtMs) {
      state.adoptDueAtMs = nowMs + 900_000;
      try {
        const adopted = await adoptOrphans(env, {log: opts.log});
        if (adopted > 0) opts.log?.info('adopted orphaned PRs', {adopted});
      } catch (error) {
        opts.log?.error('adoption sweep failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    try {
      await pushObservations(channel, env, state.registryId, now, opts.log);
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
export async function pushObservations(
  channel: ChannelWriter,
  env: NodeJS.ProcessEnv,
  session: string,
  at: string,
  log?: Logger
): Promise<void> {
  await withDatabase(undefined, env, async (db) => {
    const events = new PrEventStore(db);
    const prs = new PrStore(db);
    const watches = new WatchStore(db);
    const workers = new WorkerStore(db);
    const coordination = new CoordinationStore(db);
    // An address only relays while its claim actually goes to this session;
    // otherwise the event falls through to cold re-dispatch, which claims.
    //
    // Only a claim this relay actually took carries a `turn`. A refreshed one
    // belonged to a worker that never yielded — a ticket-worker mid-run, say,
    // whose ticket changed under it — and that agent is still executing, so
    // naming its claim would hand the session a token for a live turn. The
    // event still relays; there is simply nothing to hand over afterwards.
    const relayTarget = async (
      ref: string | null,
      node: string
    ): Promise<{agent: string; turn?: string} | null> => {
      if (ref === null) return null;
      const claimed = await coordination.claim({
        node,
        session,
        claimedAt: at,
      });
      if (claimed.outcome === 'claimed') return {agent: ref, turn: at};
      return claimed.outcome === 'refreshed' ? {agent: ref} : null;
    };

    for (const event of await events.undelivered(session)) {
      try {
        // Every fallible step — the snapshot's JSON parse, the render, the
        // lookups — runs before the event is marked delivered. A malformed
        // snapshot then leaves the row undelivered to retry next tick instead
        // of being marked delivered and lost, and the per-event catch keeps
        // one bad event from aborting the whole drain.
        const pr = await prs.getPr(event.node);
        // When a live worker holds this node, its address rides the event and
        // the session relays instead of letting the item cold-start.
        const ref = await workers.refFor(event.node, session);
        // A ticket event has no PR payload; the session re-reads the ticket
        // through the tracker adapter. A PR event renders from the snapshot
        // the poll already stored — no subprocess, so no per-tick push cap.
        const snapshot =
          event.kind === 'ticket_changed' ||
          pr?.repo == null ||
          pr.prNumber == null
            ? null
            : await watches.latestSnapshot(event.node);
        const body =
          snapshot !== null && pr?.repo != null && pr.prNumber != null
            ? renderSnapshot(pr.repo, pr.prNumber, snapshot)
            : event.kind === 'ticket_changed'
              ? `${event.summary} Re-read the ticket through the tracker adapter before acting.`
              : `${event.summary} No snapshot was stored; run \`pr-status --repo ${pr?.repo ?? '<repo>'} ${String(pr?.prNumber ?? 0)}\` yourself before acting.`;
        // The delivery claim is conditional: with session-NULL events
        // drainable by any server, only the one that wins it goes on to push.
        // Losing it here costs nothing, which is why it precedes the relay
        // claim below.
        if (!(await events.markDelivered(event.id, at))) continue;

        // Re-take the node's claim as part of relaying, and only after the
        // step that can lose the event: the worker gave its own back at `pr
        // yield` so the watch could arm, and its terminal act — the outcome —
        // requires one, so the address and the authority to use it have to
        // travel together. Without this a terminal event always lands one
        // dispatch short of being recorded, and the item wedges: the worker
        // row suppresses re-dispatch, and the relay is already spent.
        //
        // A claim taken for an event that then never goes out would name a
        // turn nobody was told about, and the handover could never match it —
        // so the claim is taken last, and a failure to take it degrades to a
        // relayless push rather than costing the event. From here the only
        // residual is a push that throws, a failed stdout write, i.e. a dying
        // server, which a retry could not have helped.
        //
        // Unbounded deliberately. The agent is running already, so this is
        // work that was admitted once, not a second admission — and capacity
        // is exactly what the yield handed back.
        let relay: {agent: string; turn?: string} | null = null;
        try {
          relay = await relayTarget(ref, event.node);
        } catch (error) {
          log?.error('relay claim failed; delivering without an address', {
            node: event.node,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        const meta = {
          ...event.meta,
          // `agent` and `turn` are the router's reserved keys: stamped after
          // the spread, and explicitly nulled when there is nothing to stamp,
          // so no event producer can smuggle either past the router. `turn`
          // dates the claim this relay took, and the session hands it back to
          // `dispatch worker rm` when the agent returns — that is what tells a
          // dead turn from a later one still running.
          agent: relay?.agent ?? null,
          turn: relay?.turn ?? null,
          item: event.node,
          ...(pr?.repo == null ? {} : {repo: pr.repo}),
          ...(pr?.prNumber == null ? {} : {pr: String(pr.prNumber)}),
        };
        channel.push(event.kind, meta, body);
      } catch (error) {
        log?.error('event delivery failed', {
          node: event.node,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  });
}
