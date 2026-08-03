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

/** Compute-slot ledger size when nothing configures one. */
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

    const own = await sessions.getSession(this.#session);
    const orders: WorkOrder[] = [];

    // No work order before the acknowledgement: a work order claims a node,
    // which a session that never hears the channel would never release.
    if (own?.ackedAt != null) {
      orders.push(...(await this.#fill(now)));
      orders.push(...(await this.#reviews(now)));
      orders.push(...(await this.#conditions(now)));
    }
    return {orders, retired: false};
  }

  /** Claim-then-emit for the dispatch queue, up to free compute capacity. */
  async #fill(now: string): Promise<WorkOrder[]> {
    const coordination = new CoordinationStore(this.#db);
    const held = await coordination.slotCount();
    let budget = Math.max(0, this.#maxParallel - held);
    const orders: WorkOrder[] = [];

    for (const {entry, pass} of await dispatchQueue(this.#db, {now})) {
      if (budget === 0) break;
      const claim = await coordination.claim({
        node: entry.item.id,
        session: this.#session,
        claimedAt: now,
      });
      if (claim.outcome !== 'claimed' && claim.outcome !== 'refreshed')
        continue;
      budget -= 1;
      const passNote = pass === null ? '' : ` (pass: ${pass})`;
      if (entry.item.kind === 'pr') {
        orders.push({
          kind: 'dispatch_pr',
          meta: {pr: entry.item.id, pass: pass ?? 'available'},
          body: `Launch a prompt-worker agent for PR item ${entry.item.id}${passNote}. It is claimed for this session; the agent records the outcome when done.`,
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

  /** One review order per open gate, tracked by a milestone-keyed claim. */
  async #reviews(now: string): Promise<WorkOrder[]> {
    const coordination = new CoordinationStore(this.#db);
    const orders: WorkOrder[] = [];
    for (const milestone of await milestoneStates(this.#db, {now})) {
      if (!milestone.readyForReview || milestone.reviewRecorded) continue;
      if (milestone.claim?.live === true) continue;
      const claim = await coordination.claim({
        node: milestone.id,
        session: this.#session,
        claimedAt: now,
      });
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

    await emit(
      'alert_failure',
      items
        .filter(
          (entry) =>
            entry.outcome?.outcome === 'failed' &&
            entry.outcome.retryable !== true
        )
        .map((entry) => ({
          node: entry.item.id,
          meta:
            entry.item.kind === 'pr'
              ? {pr: entry.item.id}
              : {project: entry.item.project ?? '', ticket: entry.item.id},
          body:
            entry.item.kind === 'pr'
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
