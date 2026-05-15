// Resolved, immutable dispatch configuration. Every other module
// reads from this shape; no module reads disk directly.
//
// Defaults match docs/spec/03-cli/01-daemon/02-normative.md §Runner
// configuration plus the acceptance criteria of issue #23.

export interface RunnerConfig {
  /** Path or PATH-resolvable name of the runner executable. */
  binary: string;
  /** Extra arguments appended after `binary` on every invocation. */
  extraArgs: readonly string[];
  /** Flag the daemon passes when resuming a prior session. */
  resumeFlag: string;
  /** Where to scrape the session ID from runner output. */
  sessionIdCapture: "stdout-jsonline" | "stderr-jsonline";
  /** Optional runner-specific permissions handle (e.g. "bypass"). */
  permissions?: string;
}

export interface DaemonConfig {
  /** Heartbeat cadence; minimum poll interval for the heartbeat scheduler. */
  heartbeatIntervalSeconds: number;
  /** Machine-wide cap on concurrent runners. */
  maxConcurrentRunners: number;
}

export interface LinearTrackerConfig {
  kind: "linear";
  /** OAuth token or PAT. */
  token: string;
  /** Optional workspace ID; resolved from the token if omitted. */
  workspaceId?: string;
}

export interface AsanaTrackerConfig {
  kind: "asana";
  token: string;
  /** Required for Asana — many endpoints want a workspace GID. */
  workspaceId: string;
}

export type TrackerConfig = LinearTrackerConfig | AsanaTrackerConfig;

export interface BuildkiteConfig {
  kind: "buildkite";
  token: string;
  /** Optional organization slug; helpful when the token can see many orgs. */
  organization?: string;
}

export interface GitHubActionsConfig {
  kind: "github-actions";
  /**
   * Optional explicit token. Most environments rely on the `gh` CLI's
   * stored credentials, in which case this can be omitted.
   */
  token?: string;
}

export type CIConfig = BuildkiteConfig | GitHubActionsConfig;

export interface DispatchConfig {
  runner: RunnerConfig;
  daemon: DaemonConfig;
  /** Trackers keyed by user-chosen label (e.g. "linear-personal"). */
  trackers: Readonly<Record<string, TrackerConfig>>;
  /** CI providers keyed by user-chosen label. */
  ci: Readonly<Record<string, CIConfig>>;
}

export const DEFAULT_RUNNER: RunnerConfig = {
  // Spec example uses `claude`, but the daemon MUST NOT hardcode it.
  // We still need *some* default so a stub config doesn't crash; the
  // daemon's preflight in §Start will reject a missing/unauthed binary.
  binary: "claude",
  extraArgs: [],
  resumeFlag: "--resume",
  sessionIdCapture: "stdout-jsonline",
};

export const DEFAULT_DAEMON: DaemonConfig = {
  heartbeatIntervalSeconds: 600,
  maxConcurrentRunners: 4,
};

export const DEFAULT_CONFIG: DispatchConfig = {
  runner: DEFAULT_RUNNER,
  daemon: DEFAULT_DAEMON,
  trackers: {},
  ci: {},
};
