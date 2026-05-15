// Public surface of the config module. Other modules should import
// only from "./config/index.mts" so the schema/loader split stays
// internal.

export {
  DEFAULT_CONFIG,
  DEFAULT_DAEMON,
  DEFAULT_RUNNER,
  type AsanaTrackerConfig,
  type BuildkiteConfig,
  type CIConfig,
  type DaemonConfig,
  type DispatchConfig,
  type GitHubActionsConfig,
  type LinearTrackerConfig,
  type RunnerConfig,
  type TrackerConfig,
} from "./schema.mts";
export { loadConfig, resolveConfigPath } from "./load.mts";
export { validate } from "./validate.mts";
