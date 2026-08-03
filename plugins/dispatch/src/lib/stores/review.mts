/* eslint-disable @typescript-eslint/require-await --
 * Async facade over synchronous `node:sqlite`; see `../db/database.mts`. */
import type {Database} from '../db/database.mts';
import {assertInstant} from '../db/time.mts';
import {DataError, ensure} from '../errors/index.mts';
import {RESOLVED_STATUSES} from '../model/status.mts';
import {findNode} from './materialize.mts';

/**
 * Milestone reviews. Recording snapshots the member set, which is what makes
 * a review expire: the read-model counts a review only while it covers
 * exactly the current members and none moved after it was recorded.
 */
export class ReviewStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  async record(milestone: string, at: string): Promise<void> {
    assertInstant(at, 'at');
    await this.#db.transaction(() => {
      const node = findNode(this.#db, milestone);
      ensure(
        node !== null && node.kind === 'milestone',
        () =>
          new DataError(`"${milestone}" is not a milestone in the graph`, {
            hint: 'record a review on a milestone the graph already holds.',
          })
      );
      const members = this.#db.all(
        `SELECT n.external_id AS id, t.status
         FROM edge e
         JOIN ticket t ON t.node_id = e.blocker
         JOIN node n ON n.id = e.blocker
         WHERE e.blocked = ?
         ORDER BY id`,
        [node.id]
      );
      ensure(
        members.length > 0,
        () =>
          new DataError(`milestone "${milestone}" has no members to review`, {
            hint: 'a review covers member tickets; join them with edge add first.',
          })
      );
      const open = members.filter(
        (member) =>
          !(RESOLVED_STATUSES as ReadonlySet<string>).has(String(member.status))
      );
      ensure(
        open.length === 0,
        () =>
          new DataError(
            `milestone "${milestone}" still has unresolved members: ${open
              .map((member) => String(member.id))
              .join(', ')}`,
            {
              hint: 'a milestone is reviewed once every member is verified or canceled.',
            }
          )
      );
      this.#db.run(
        `INSERT INTO review (milestone_id, recorded_at) VALUES (?, ?)
         ON CONFLICT(milestone_id) DO UPDATE SET recorded_at = excluded.recorded_at`,
        [node.id, at]
      );
      this.#db.run('DELETE FROM review_member WHERE milestone_id = ?', [
        node.id,
      ]);
      for (const member of members) {
        this.#db.run(
          'INSERT INTO review_member (milestone_id, member_external_id) VALUES (?, ?)',
          [node.id, String(member.id)]
        );
      }
      // The review opens the gate; the reviewing claim has served its purpose.
      this.#db.run('DELETE FROM claim WHERE node_id = ?', [node.id]);
    });
  }

  /** End a review without recording it — the gate stays closed. */
  async release(milestone: string): Promise<boolean> {
    return this.#db.guard(() => {
      const node = findNode(this.#db, milestone);
      ensure(
        node !== null && node.kind === 'milestone',
        () =>
          new DataError(`"${milestone}" is not a milestone in the graph`, {
            hint: 'name the milestone the review order carried.',
          })
      );
      return this.#db.run('DELETE FROM claim WHERE node_id = ?', [node.id]) > 0;
    });
  }
}

/* eslint-enable @typescript-eslint/require-await */
