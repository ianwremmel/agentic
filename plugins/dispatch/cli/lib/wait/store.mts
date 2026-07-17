import assert from 'node:assert';

import {Database} from '../db/database.mts';
import {DataError} from '../errors.mts';

/** The waits a delivery agent observes and tunes its polling schedule around. */
export const WAIT_KINDS = ['ci', 'reviewer', 'merge'] as const;
export type WaitKind = (typeof WAIT_KINDS)[number];

export function isWaitKind(value: string): value is WaitKind {
  return (WAIT_KINDS as readonly string[]).includes(value);
}

/**
 * Old samples beyond this many per (repo, kind) are dropped at write time. The
 * memory should reflect the project as it is now, not its whole history.
 */
const CAP = 100;

export interface WaitStats {
  kind: WaitKind;
  count: number;
  medianS: number;
}

/**
 * Per-repo wait history over the shared dispatch database: how long CI,
 * reviewers, and merges have actually taken, and the medians an agent tunes its
 * polling schedule from. The store owns the sample cap and the arithmetic, so
 * an agent never keeps or computes this memory itself.
 */
export class WaitStore {
  readonly #db: Database;

  private constructor(db: Database) {
    this.#db = db;
  }

  static async open(path: string): Promise<WaitStore> {
    return new WaitStore(await Database.open(path));
  }

  async close(): Promise<void> {
    await this.#db.close();
  }

  /** Record one observed wait; returns the kind's stats including it. */
  async record(
    sample: {
      repo: string;
      kind: WaitKind;
      elapsedS: number;
      outcome: string | null;
    },
    nowMs: number
  ): Promise<WaitStats> {
    assert(
      Number.isInteger(sample.elapsedS) && sample.elapsedS >= 0,
      new DataError(
        `an elapsed time must be a non-negative whole number of seconds, not ${String(sample.elapsedS)}`,
        {hint: 'pass --elapsed the wait in seconds, e.g. --elapsed 340.'}
      )
    );
    return this.#db.transaction(() => {
      this.#db.run(
        `INSERT INTO wait_sample (repo, kind, elapsed_s, outcome, recorded_at_ms)
         VALUES (?, ?, ?, ?, ?)`,
        [sample.repo, sample.kind, sample.elapsedS, sample.outcome, nowMs]
      );
      this.#db.run(
        `DELETE FROM wait_sample
         WHERE repo = ? AND kind = ? AND id NOT IN (
           SELECT id FROM wait_sample WHERE repo = ? AND kind = ?
           ORDER BY id DESC LIMIT ?
         )`,
        [sample.repo, sample.kind, sample.repo, sample.kind, CAP]
      );
      const stats = this.#stats(sample.repo).find(
        (entry) => entry.kind === sample.kind
      );
      assert(stats !== undefined, 'a kind just recorded must have stats');
      return stats;
    });
  }

  /** Stats for every kind the repo has samples of. */
  async stats(repo: string): Promise<WaitStats[]> {
    return Promise.resolve(this.#stats(repo));
  }

  #stats(repo: string): WaitStats[] {
    const out: WaitStats[] = [];
    for (const kind of WAIT_KINDS) {
      const rows = this.#db.all(
        `SELECT elapsed_s FROM wait_sample
         WHERE repo = ? AND kind = ? ORDER BY elapsed_s`,
        [repo, kind]
      );
      if (rows.length === 0) continue;
      const sorted = rows.map((row) => Number(row.elapsed_s));
      out.push({kind, count: sorted.length, medianS: median(sorted)});
    }
    return out;
  }
}

/** The median of an ascending list; an even count averages the middle pair. */
function median(sorted: readonly number[]): number {
  const mid = Math.floor(sorted.length / 2);
  const a = sorted[mid];
  const b = sorted[sorted.length % 2 === 0 ? mid - 1 : mid];
  assert(a !== undefined && b !== undefined, 'median of a non-empty list');
  return Math.round((a + b) / 2);
}
