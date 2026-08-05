import type {Database} from '../db/database.mts';
import {
  DEFAULT_STALE_AFTER_SECONDS,
  dispatchQueue,
  milestoneStates,
} from '../graph/index.mts';
import {classifiedItems} from '../graph/index.mts';
import {derive} from '../graph/index.mts';
import {
  CoordinationStore,
  NoticeStore,
  SessionStore,
} from '../stores/index.mts';
import type {NoticeKind} from '../stores/notice.mts';

/** Compute-slot ledger size and admission cap when nothing configures one. */
export const DEFAULT_MAX_PARALLEL = 3;

export interface WorkOrder {
  kind:
    | 'dispatch_ticket'
    | 'dispatch_pr'
    | 'perform_milestone_review'
    | 'park_human_blocked'
    | 'alert_failure'
    | 'project_complete';
  meta: Record<string, string>;
  body: string;
}

export interface TickResult {
  orders: WorkOrder[];
  /** The session's own row is gone; the server must exit, not re-register. */
  retired: boolean;
}

/**
 * The deterministic half of orchestration: everything the server decides on a
 * tick. Reads the derived read-model, claims before it emits, and returns the
 * work orders to push — it never touches the channel itself, so it tests
 * without one.
 */
export class Scheduler {
  readonly #db: Database;
  readonly #session: string;
  readonly #maxParallel: number;
  readonly #requireAck: boolean;

  constructor(
    db: Database,
    opts: {
      session: string;
      maxParallel?: number | undefined;
      /**
       * Whether emission waits on the channel acknowledgement. The server's
       * timer tick requires it — a pushed order an unhearing session never
       * receives would claim a node forever. The CLI `tick` command turns it
       * off: its orders are printed to the caller synchronously, so delivery
       * is proven by the call itself.
       */
      requireAck?: boolean | undefined;
    }
  ) {
    this.#db = db;
    this.#session = opts.session;
    this.#maxParallel = opts.maxParallel ?? DEFAULT_MAX_PARALLEL;
    this.#requireAck = opts.requireAck ?? true;
  }

  async tick(now: string): Promise<TickResult> {
    const sessions = new SessionStore(this.#db);
    if (!(await sessions.heartbeat(this.#session, now))) {
      return {orders: [], retired: true};
    }
    await sessions.sweepStale(now, DEFAULT_STALE_AFTER_SECONDS);

    const own = await sessions.getSession(this.#session);
    const orders: WorkOrder[] = [];

    // No work order before the acknowledgement: a work order claims a node,
    // which a session that never hears the channel would never release.
    if (!this.#requireAck || own?.ackedAt != null) {
      // One admission budget per tick: the cap minus everything in flight — a
      // claim is an obligation to run an agent, so it consumes capacity from
      // the moment it exists, not from when its worker takes a slot. Reviews
      // spend first: a review is the continuation of already-landed work and
      // opens a gate other work waits behind.
      const coordination = new CoordinationStore(this.#db);
      const inFlight = await coordination.inFlightCount({
        now,
        staleAfterSeconds: DEFAULT_STALE_AFTER_SECONDS,
      });
      const budget = Math.max(0, this.#maxParallel - inFlight);
      const reviews = await this.#reviews(now, budget);
      orders.push(...reviews);
      orders.push(...(await this.#fill(now, budget - reviews.length)));
      orders.push(...(await this.#conditions(now)));
    }
    return {orders, retired: false};
  }

  /** Claim-then-emit for the dispatch queue, up to the remaining budget. */
  async #fill(now: string, budget: number): Promise<WorkOrder[]> {
    const coordination = new CoordinationStore(this.#db);
    const orders: WorkOrder[] = [];

    for (const {entry, pass} of await dispatchQueue(this.#db, {now})) {
      if (orders.length >= budget) break;
      // Only a fresh claim emits. `refreshed` means this session already held
      // one — the queue excludes live-claimed nodes, so that can only be a
      // concurrent tick of the same session (the CLI `tick` racing the timer)
      // that claimed it between this tick's queue read and now. That emitter
      // owns the order; emitting here too would double-dispatch the node.
      const claim = await coordination.claim({
        node: entry.item.id,
        session: this.#session,
        claimedAt: now,
      });
      if (claim.outcome !== 'claimed') continue;
      const passNote = pass === null ? '' : ` (pass: ${pass})`;
      if (entry.item.kind === 'pr') {
        orders.push({
          kind: 'dispatch_pr',
          meta: {
            pr: entry.item.id,
            pass: pass ?? 'available',
            ...(entry.item.ticket === null ? {} : {ticket: entry.item.ticket}),
          },
          body: `Launch a pr-worker agent for PR item ${entry.item.id}${entry.item.ticket === null ? '' : ` (implements ticket ${entry.item.ticket})`}${passNote}. It is claimed for this session; the agent records the outcome when done.`,
        });
      } else {
        orders.push({
          kind: 'dispatch_ticket',
          meta: {
            project: entry.item.project ?? '',
            ticket: entry.item.id,
            pass: pass ?? 'available',
          },
          body: `Launch a ticket-worker agent for ticket ${entry.item.id}${passNote}. It is claimed for this session; the agent records the outcome when done.`,
        });
      }
    }
    return orders;
  }

  /**
   * One review order per open gate, tracked by a milestone-keyed claim and
   * bounded by the shared budget — a review order launches an agent too.
   */
  async #reviews(now: string, budget: number): Promise<WorkOrder[]> {
    const coordination = new CoordinationStore(this.#db);
    const orders: WorkOrder[] = [];
    for (const milestone of await milestoneStates(this.#db, {now})) {
      if (orders.length >= budget) break;
      if (!milestone.readyForReview || milestone.reviewRecorded) continue;
      if (milestone.claim?.live === true) continue;
      // Fresh claims only, for the same reason as in `#fill`: a `refreshed`
      // outcome here is a concurrent same-session tick that beat this one to
      // the milestone.
      const claim = await coordination.claim({
        node: milestone.id,
        session: this.#session,
        claimedAt: now,
      });
      if (claim.outcome !== 'claimed') continue;
      orders.push({
        kind: 'perform_milestone_review',
        meta: {project: milestone.project, milestone: milestone.id},
        body: `Launch a milestone-reviewer agent for milestone ${milestone.id} in project ${milestone.project}. Recording the review opens the gate.`,
      });
    }
    return orders;
  }

  /**
   * The tick's non-scheduling duties, fired once per episode: park
   * human-blocked work, surface unrecoverable failures, announce completion.
   */
  async #conditions(now: string): Promise<WorkOrder[]> {
    const notices = new NoticeStore(this.#db);
    const orders: WorkOrder[] = [];
    const items = await classifiedItems(this.#db, {now});

    const emit = async (
      kind: NoticeKind,
      holding: {node: string; meta: Record<string, string>; body: string}[]
    ): Promise<void> => {
      for (const {node, meta, body} of holding) {
        if (await notices.has(kind, node)) continue;
        await notices.record(kind, node, now);
        orders.push({kind, meta, body});
      }
      await notices.prune(
        kind,
        holding.map((entry) => entry.node)
      );
    };

    await emit(
      'park_human_blocked',
      items
        .filter(
          (entry) =>
            entry.item.kind === 'ticket' &&
            entry.classification === 'human-blocked' &&
            entry.item.status !== 'paused' &&
            entry.item.status !== 'awaiting-external'
        )
        .map((entry) => ({
          node: entry.item.id,
          meta: {
            project: entry.item.project ?? '',
            ticket: entry.item.id,
          },
          body: `Ticket ${entry.item.id} needs a human. Park it (awaiting-external, or paused if the tracker lacks it) and post the handoff through the tracker adapter.`,
        }))
    );

    // A human-blocked PR item shares the alert channel with failures: the
    // item has no status to park, so the alert is the only way the operator
    // hears the question its worker left behind. The episode marker keys on
    // the outcome kind too, so replacing a failed outcome with a fresh
    // human-blocked question (or vice versa) starts a new episode.
    await emit(
      'alert_failure',
      items
        .filter(
          (entry) =>
            (entry.outcome?.outcome === 'failed' &&
              entry.outcome.retryable !== true) ||
            (entry.item.kind === 'pr' &&
              entry.outcome?.outcome === 'human-blocked')
        )
        .map((entry) => ({
          node: `${entry.item.id}#${entry.outcome?.outcome ?? ''}`,
          meta:
            entry.item.kind === 'pr'
              ? {
                  pr: entry.item.id,
                  ...(entry.item.ticket === null
                    ? {}
                    : {ticket: entry.item.ticket}),
                }
              : {project: entry.item.project ?? '', ticket: entry.item.id},
          body:
            entry.outcome?.outcome === 'human-blocked'
              ? `PR item ${entry.item.id} is waiting on an operator response${entry.outcome.detail == null ? '' : ` (${entry.outcome.detail})`}. Alert the operator on the PR if one exists, else on its ticket, and requeue with \`dispatch outcome rm --id ${entry.item.id}\` once the response arrives.`
              : entry.item.kind === 'pr'
                ? `PR item ${entry.item.id} failed unrecoverably${entry.outcome?.detail == null ? '' : ` (${entry.outcome.detail})`}. Alert the operator; requeue by removing the outcome once addressed.`
                : `Ticket ${entry.item.id} failed unrecoverably${entry.outcome?.detail == null ? '' : ` (${entry.outcome.detail})`}. Alert the operator on the ticket; requeue by removing the outcome once addressed.`,
        }))
    );

    const graph = await derive(this.#db, {now});
    await emit(
      'project_complete',
      graph.projects
        .filter((project) => project.terminal)
        .map((project) => ({
          node: project.id,
          meta: {project: project.id},
          body: `Project ${project.id} is complete: every ticket is verified or canceled. Announce it and stop when no other project remains.`,
        }))
    );

    return orders;
  }
}
