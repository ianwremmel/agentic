/* eslint-disable @typescript-eslint/require-await --
 * `node:sqlite` is synchronous; the async facade keeps call sites stable. */
import type {Database} from '../db/database.mts';
import {
  PREFIX,
  PROJECT_FILTER,
  QUEUE_ORDER,
  RANK_ORDER,
  pipelineParams,
} from './pipeline.mts';
import {integer, splitList, text, toClaim, toClassified} from './rows.mts';
import type {
  ClassifiedItem,
  DeriveOptions,
  MilestoneState,
  Pass,
  QueueEntry,
} from './types.mts';

/** Every work item, classified, ordered by external id. */
export async function classifiedItems(
  db: Database,
  options: DeriveOptions = {}
): Promise<ClassifiedItem[]> {
  return db
    .all(
      `${PREFIX} SELECT * FROM classified WHERE ${PROJECT_FILTER} ORDER BY id`,
      pipelineParams(options)
    )
    .map(toClassified);
}

/**
 * The ranked available frontier, most urgent first. An item carrying an
 * outcome row is excluded — its next dispatch is a pass, not fresh work.
 */
export async function frontier(
  db: Database,
  options: DeriveOptions = {}
): Promise<ClassifiedItem[]> {
  return db
    .all(
      `${PREFIX} SELECT * FROM queued WHERE pass = 'available' AND ${PROJECT_FILTER} ${RANK_ORDER}`,
      pipelineParams(options)
    )
    .map(toClassified);
}

/**
 * Everything the scheduler may hand out right now, in dispatch order. The one
 * read the server's fill step runs, so pick and admit always agree.
 */
export async function dispatchQueue(
  db: Database,
  options: DeriveOptions = {}
): Promise<QueueEntry[]> {
  return db
    .all(
      `${PREFIX} SELECT * FROM queued WHERE pass IS NOT NULL AND ${PROJECT_FILTER} ${QUEUE_ORDER}`,
      pipelineParams(options)
    )
    .map((row) => ({
      entry: toClassified(row),
      pass: row.pass === 'available' ? null : (text(row.pass) as Pass),
    }));
}

/** Every milestone's derived state, ordered by project then id. */
export async function milestoneStates(
  db: Database,
  options: DeriveOptions = {}
): Promise<MilestoneState[]> {
  const rows = db.all(
    `${PREFIX}
     SELECT
       n.external_id AS id,
       np.external_id AS project,
       mi.name,
       ms.member_count,
       ms.open_count,
       ms.dep_blocked,
       ms.review_recorded,
       ms.id IN (SELECT id FROM milestone_open) AS open,
       c.session_id AS claim_session,
       c.actor AS claim_actor,
       c.worktree AS claim_worktree,
       c.branch AS claim_branch,
       c.claimed_at AS claim_claimed_at,
       CASE
         WHEN c.node_id IS NULL THEN NULL
         WHEN lc.node_id IS NOT NULL THEN 1
         ELSE 0
       END AS claim_live,
       (SELECT group_concat(mem.external_id, ',' ORDER BY mem.external_id)
          FROM member mem WHERE mem.milestone_id = ms.id) AS members
     FROM milestone_state ms
     JOIN milestone mi ON mi.node_id = ms.id
     JOIN node n ON n.id = ms.id
     JOIN node np ON np.id = mi.project_id
     LEFT JOIN claim c ON c.node_id = ms.id
     LEFT JOIN live_claim lc ON lc.node_id = ms.id
     ORDER BY project, id`,
    pipelineParams(options)
  );

  return rows.map((row) => ({
    id: text(row.id) ?? '',
    project: text(row.project) ?? '',
    name: text(row.name) ?? '',
    members: splitList(row.members),
    memberCount: integer(row.member_count),
    openCount: integer(row.open_count),
    readyForReview:
      integer(row.member_count) > 0 &&
      integer(row.open_count) === 0 &&
      integer(row.dep_blocked) === 0,
    reviewRecorded: integer(row.review_recorded) === 1,
    open: integer(row.open) === 1,
    claim: toClaim(row),
  }));
}

/* eslint-enable @typescript-eslint/require-await */
