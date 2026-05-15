export type ChecksRollupState = "pending" | "success" | "failure";

export interface CheckSummary {
  /** GitHub check bucket: pass | fail | pending | skipping | cancel. */
  bucket?: string;
  name?: string;
  state?: string;
  conclusion?: string;
}

export interface ChecksEvent {
  /** Raw JSON value emitted by `gh pr checks --json …`. */
  raw: unknown;
  /** Normalized rollup of all checks in this snapshot. */
  state: ChecksRollupState;
  /** True when the snapshot is terminal (success or failure). */
  terminal: boolean;
  /** Flattened list of checks parsed from the snapshot, if available. */
  checks?: CheckSummary[];
}

export interface WatchChecksOptions {
  /** GitHub repo in `owner/name` form. */
  repo: string;
  prNumber: number;
}
