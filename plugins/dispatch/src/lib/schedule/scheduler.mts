import type {Database} from '../db/database.mts';
import {
  DEFAULT_STALE_AFTER_SECONDS,
  dispatchQueue,
  milestoneStates,
} from '../graph/index.mts';
import {classifiedItems} from '../graph/index.mts';
import {derive, repoPrLoad} from '../graph/index.mts';
import {
  CoordinationStore,
  FetchRequestStore,
  NoticeStore,
  PolicyStore,
  SessionStore,
} from '../stores/index.mts';
import type {NoticeKind} from '../stores/notice.mts';
import {RepoAdmission} from './caps.mts';

/** How many agents may be in flight at once when nothing configures it. */
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

  constructor(
    db: Database,
    opts: {session: string; maxParallel?: number | undefined}
  ) {
    this.#db = db;
    this.#session = opts.session;
    this.#maxParallel = opts.maxParallel ?? DEFAULT_MAX_PARALLEL;
  }

  async tick(now: string): Promise<TickResult> {
    const sessions = new SessionStore(this.#db);
    if (!(await sessions.heartbeat(this.#session, now))) {
      return {orders: [], retired: true};
    }
    await sessions.sweepStale(now, DEFAULT_STALE_AFTER_SECONDS);

    await this.#refreshTickets(now);

    const own = await sessions.getSession(this.#session);
    const orders: WorkOrder[] = [];

    // No work order before the acknowledgement: a work order claims a node,
    // which a session that never hears the channel would never release.
    if (own?.ackedAt != null) {
      // One admission budget per tick: the cap minus everything in flight. A
      // claim is both the obligation to run an agent and that agent's compute
      // grant, so it consumes capacity from the moment it exists. Reviews
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
      // The per-repo caps bound resources the claim ledger cannot see: a PR
      // holds preview stacks and cloud quota for as long as it stays open,
      // and a yielded worker holds no claim at all.
      const admission = new RepoAdmission(
        await new PolicyStore(this.#db).getRepoCaps(),
        await repoPrLoad(this.#db)
      );
      orders.push(
        ...(await this.#fill(now, budget - reviews.length, admission))
      );
      orders.push(...(await this.#conditions(now)));
    }
    return {orders, retired: false};
  }

  /**
   * Ask the session to re-read tickets whose tracker state can change under
   * us, on a cadence derived from where each ticket is. The server cannot
   * read the tracker itself, so it owns the *when*: the ask is a durable
   * `refresh_ticket` instruction the drain delivers once the channel is
   * acked, `ticket set` is the answer, and a status change the write reveals
   * is pushed as an event. Backlog and terminal tickets are not asked about —
   * the scan covers them — and one ask per ticket stays open at a time.
   *
   * In-flight tickets move on a person's timescale (a reply, a review), so
   * five minutes; parked ones on an operator's (fifteen).
   */
  async #refreshTickets(now: string): Promise<void> {
    const requests = new FetchRequestStore(this.#db);
    // An ask pushed ten minutes ago and never answered was lost in flight;
    // clearing its mark lets the drain offer it again.
    await requests.redeliverStaleTicketRefreshes(now, 600);
    const rows = this.#db.all(
      `SELECT n.external_id AS id, t.status, p.source
       FROM ticket t
       JOIN node n ON n.id = t.node_id
       JOIN project p ON p.node_id = t.project_id
       WHERE p.source IS NOT NULL
         AND t.status IN ('in-progress','in-review','finished','delivered',
                          'paused','awaiting-external')`
    );
    const nowMs = Date.parse(now);
    for (const row of rows) {
      const status = String(row.status);
      const cadenceMs =
        status === 'paused' || status === 'awaiting-external'
          ? 900_000
          : 300_000;
      const ticket = String(row.id);
      const last = await requests.lastTicketRefreshAt(ticket);
      if (last !== null && nowMs - Date.parse(last) < cadenceMs) continue;
      await requests.enqueueTicketRefresh({
        source: String(row.source),
        ticket,
        at: now,
      });
    }
  }

  /**
   * Claim-then-emit for the dispatch queue, up to the remaining budget. The
   * budget bounds this tick's work; the cap passed to `claim` is what actually
   * binds, because a second server scheduling concurrently computed its budget
   * from the same pre-claim reading. A `full` outcome ends the pass — the
   * later entries cannot fit either.
   *
   * A per-repo cap ends nothing: it refuses one entry, and a later entry for
   * another repo may still fit. Only PR items are gated; a ticket-worker keeps
   * planning and registering PR items, which then wait in the queue for a slot
   * — that is the queue doing its job.
   */
  async #fill(
    now: string,
    budget: number,
    admission: RepoAdmission
  ): Promise<WorkOrder[]> {
    const coordination = new CoordinationStore(this.#db);
    const orders: WorkOrder[] = [];

    for (const {entry, pass} of await dispatchQueue(this.#db, {now})) {
      if (orders.length >= budget) break;
      if (entry.item.kind === 'pr' && admission.admit(entry.item) !== null)
        continue;
      const claim = await coordination.claim({
        node: entry.item.id,
        session: this.#session,
        claimedAt: now,
        capacity: {
          max: this.#maxParallel,
          staleAfterSeconds: DEFAULT_STALE_AFTER_SECONDS,
        },
      });
      if (claim.outcome === 'full') break;
      if (claim.outcome !== 'claimed' && claim.outcome !== 'refreshed')
        continue;
      const passNote = pass === null ? '' : ` (pass: ${pass})`;
      if (entry.item.kind === 'pr') {
        admission.reserve(entry.item);
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
      const claim = await coordination.claim({
        node: milestone.id,
        session: this.#session,
        claimedAt: now,
        capacity: {
          max: this.#maxParallel,
          staleAfterSeconds: DEFAULT_STALE_AFTER_SECONDS,
        },
      });
      if (claim.outcome === 'full') break;
      if (claim.outcome !== 'claimed' && claim.outcome !== 'refreshed')
        continue;
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
