/* eslint-disable @typescript-eslint/require-await --
 * `node:sqlite` is synchronous; the async facade keeps call sites stable. */
import type {Database} from '../db/database.mts';
import {nowIso} from '../db/time.mts';
import {
  DEFAULT_STALE_AFTER_SECONDS,
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

/** What one PR item costs the repo it belongs to, right now. */
export interface RepoPrLoad {
  node: string;
  repo: string;
  /** A PR is on the forge and still open, or a live worker is about to open one. */
  open: boolean;
  /** Checks are running, or a live worker is about to start some. */
  building: boolean;
}

/**
 * Per-repo load for the admission caps, read from the graph and the snapshots
 * the watch poll already stored — no fetch of its own.
 *
 * A terminal outcome settles the item whatever the forge last said, so it
 * counts for nothing. Without one, an item that names a PR number is open
 * until a snapshot says otherwise: the poll has to have run at least once for
 * a closed PR to stop counting, and the cap should hold rather than let go on
 * an item nobody has looked at yet.
 *
 * A live claim counts as both. The work it names is a dispatched pr-worker,
 * which will open a PR (if the item has none yet) and push to it — neither
 * visible in a snapshot until it happens, so a cap reading only the forge
 * would admit a second item on every tick until the first one's PR appeared.
 * The claim is shared state, so this is also what keeps a second server on the
 * same database from re-spending a slot this one just spent.
 *
 * `building` is deliberately not scoped to open PRs: a merged PR's trailing
 * jobs hold CI concurrency exactly like any other, and its item stops counting
 * as soon as its worker reports.
 */
export async function repoPrLoad(
  db: Database,
  options: DeriveOptions = {}
): Promise<RepoPrLoad[]> {
  return db
    .all(
      `SELECT n.external_id AS node, pr.repo, pr.pr_number, o.outcome,
              json_extract(w.snapshot, '$.state') AS pr_state,
              json_extract(w.snapshot, '$.rollup') AS rollup,
              lc.node_id IS NOT NULL AS claimed
       FROM pr
       JOIN node n ON n.id = pr.node_id
       LEFT JOIN watch w ON w.node_id = pr.node_id
       LEFT JOIN outcome o ON o.node_id = pr.node_id
       LEFT JOIN (
         SELECT c.node_id FROM claim c
         JOIN session s ON s.id = c.session_id
         WHERE unixepoch(?) - unixepoch(s.heartbeat_at) <= ?
       ) lc ON lc.node_id = pr.node_id
       WHERE pr.repo IS NOT NULL
       ORDER BY n.external_id`,
      [
        options.now ?? nowIso(),
        options.staleAfterSeconds ?? DEFAULT_STALE_AFTER_SECONDS,
      ]
    )
    .map((row) => {
      const settled = RESOLVED_OUTCOMES.has(text(row.outcome) ?? '');
      const claimed = !settled && integer(row.claimed) === 1;
      const state = text(row.pr_state);
      const unopened = row.pr_number === null || row.pr_number === undefined;
      return {
        node: text(row.node) ?? '',
        repo: text(row.repo) ?? '',
        open: unopened
          ? claimed
          : !settled && (state === null || state === 'OPEN'),
        building: claimed || (!settled && text(row.rollup) === 'PENDING'),
      };
    });
}

/** Outcomes that end a PR item's life, whatever the forge last reported. */
const RESOLVED_OUTCOMES: ReadonlySet<string> = new Set([
  'delivered',
  'verified',
  'canceled',
]);

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
     WHERE ((SELECT project_filter FROM p) IS NULL
        OR np.external_id = (SELECT project_filter FROM p))
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
