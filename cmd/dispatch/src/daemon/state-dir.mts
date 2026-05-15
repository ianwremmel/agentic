import { homedir, platform } from "node:os";
import { join } from "node:path";

/**
 * Resolves the daemon's state directory per §3.1.2.
 *
 * Linux: $XDG_STATE_HOME/dispatch or ~/.local/state/dispatch
 * macOS: ~/Library/Application Support/dispatch
 *
 * The DISPATCH_STATE_DIR env var overrides the platform default and is the
 * supported escape hatch for tests and alternate installs.
 */
export function resolveStateDir(): string {
  const override = process.env["DISPATCH_STATE_DIR"];
  if (override && override.length > 0) return override;

  const home = homedir();
  switch (platform()) {
    case "darwin":
      return join(home, "Library", "Application Support", "dispatch");
    case "linux": {
      const xdg = process.env["XDG_STATE_HOME"];
      if (xdg && xdg.length > 0) return join(xdg, "dispatch");
      return join(home, ".local", "state", "dispatch");
    }
    default:
      // Spec lists only darwin and linux as supported targets, but we keep a
      // sensible fallback so the CLI runs in unsupported envs (CI, dev).
      return join(home, ".dispatch");
  }
}

export interface StatePaths {
  root: string;
  pidFile: string;
  logFile: string;
  tasksDir: string;
  eventsDir: string;
}

export function statePaths(root = resolveStateDir()): StatePaths {
  return {
    root,
    pidFile: join(root, "daemon.pid"),
    logFile: join(root, "daemon.log"),
    tasksDir: join(root, "tasks"),
    eventsDir: join(root, "events"),
  };
}
