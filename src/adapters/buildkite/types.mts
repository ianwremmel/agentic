export type BuildState =
  | "running"
  | "passed"
  | "failed"
  | "blocked"
  | "canceled";

export interface BuildEvent {
  /** Raw event emitted by the Buildkite CLI. */
  raw: unknown;
  /**
   * Normalized rollup state. Terminal states: `passed`, `failed`,
   * `blocked`, `canceled`. `running` for any non-terminal update.
   */
  state: BuildState;
  /** True when the event represents a terminal state. */
  terminal: boolean;
  /** Optional fields surfaced for downstream callers. */
  buildNumber?: number;
  url?: string;
  pipeline?: string;
}

export interface WatchBuildOptions {
  org: string;
  pipeline: string;
  buildNumber: number;
}
