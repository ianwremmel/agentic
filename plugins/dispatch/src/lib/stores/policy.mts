import type {Database} from '../db/database.mts';
import {DEFAULT_REPO_CAPS} from '../model/index.mts';
import type {RepoCapPolicy} from '../model/index.mts';

/* eslint-disable @typescript-eslint/require-await --
 * Async facade over synchronous `node:sqlite`; see `../db/database.mts`. */

const REPO_CAPS_KEY = 'repo_caps';

/**
 * The admission policy the running server was started with, kept in the
 * database so a reader that is not that server — `dispatch status`, mainly —
 * reports against the caps actually in force instead of guessing the
 * defaults. The server writes it at startup; the last one to start wins,
 * which matches the caps' meaning: they bound one host's shared resources,
 * not one session's share of them.
 */
export class PolicyStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  /** The stored policy, or the defaults when none was ever written. */
  async getRepoCaps(): Promise<RepoCapPolicy> {
    const row = this.#db.get('SELECT value FROM meta WHERE key = ?', [
      REPO_CAPS_KEY,
    ]);
    if (typeof row?.value !== 'string') return DEFAULT_REPO_CAPS;
    const stored = JSON.parse(row.value) as Partial<RepoCapPolicy>;
    return {
      openPrs: stored.openPrs ?? DEFAULT_REPO_CAPS.openPrs,
      inFlightBuilds: stored.inFlightBuilds ?? DEFAULT_REPO_CAPS.inFlightBuilds,
      openPrsByRepo: stored.openPrsByRepo ?? {},
      inFlightBuildsByRepo: stored.inFlightBuildsByRepo ?? {},
    };
  }

  async setRepoCaps(policy: RepoCapPolicy): Promise<void> {
    this.#db.run('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', [
      REPO_CAPS_KEY,
      JSON.stringify(policy),
    ]);
  }
}

/* eslint-enable @typescript-eslint/require-await */
