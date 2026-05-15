// State directory layout per spec §State directory.
//
//   <root>/daemon.pid
//   <root>/daemon.log
//   <root>/tasks/<encoded-id>.json
//   <root>/events/<ts>-<encoded-id>.json
//
// Root resolution:
//   macOS:  $HOME/Library/Application Support/dispatch
//   Linux:  $XDG_STATE_HOME/dispatch  ||  $HOME/.local/state/dispatch
//
// All other modules MUST go through this resolver; nobody else should
// hardcode the layout.

import { mkdirSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { encodeTaskId } from "./encoding.mts";

export interface ResolveOptions {
  env?: NodeJS.ProcessEnv;
  /**
   * Override the platform string. Tests set this to drive both
   * branches without spawning a different OS.
   */
  platform?: NodeJS.Platform;
  /**
   * Direct root override. When set, neither env nor platform is
   * consulted. Used by tests and (in future) a `DISPATCH_STATE_DIR`
   * env var if we add one.
   */
  root?: string;
}

export function resolveStateRoot(opts: ResolveOptions = {}): string {
  if (opts.root && opts.root.length > 0) return opts.root;
  const env = opts.env ?? process.env;
  const plat = opts.platform ?? platform();
  const home = env.HOME ?? homedir();
  if (plat === "darwin") {
    return join(home, "Library", "Application Support", "dispatch");
  }
  // Treat anything non-darwin as Linux-style. Windows isn't a
  // supported target for v1 per the epic; we don't try to be clever.
  const xdg = env.XDG_STATE_HOME;
  if (xdg && xdg.length > 0) return join(xdg, "dispatch");
  return join(home, ".local", "state", "dispatch");
}

export interface StateLayout {
  /** Absolute root of the dispatch state directory. */
  root: string;
  /** `<root>/daemon.pid` — single-instance lock file. */
  pidFile: string;
  /** `<root>/daemon.log` — append-only daemon log. */
  logFile: string;
  /** `<root>/tasks` — one JSON per task, keyed by encoded ID. */
  tasksDir: string;
  /** `<root>/events` — newline-of-files event spool. */
  eventsDir: string;
  /** Resolve the JSON path for a given canonical task ID. */
  taskFile(id: string): string;
  /** Resolve the JSON path for a given event timestamp + task ID. */
  eventFile(timestamp: string, id: string): string;
}

export function layoutForRoot(root: string): StateLayout {
  const tasksDir = join(root, "tasks");
  const eventsDir = join(root, "events");
  return {
    root,
    pidFile: join(root, "daemon.pid"),
    logFile: join(root, "daemon.log"),
    tasksDir,
    eventsDir,
    taskFile(id) {
      return join(tasksDir, `${encodeTaskId(id)}.json`);
    },
    eventFile(timestamp, id) {
      // Events are sorted lexicographically; the timestamp goes first
      // so `readdir` returns events in chronological order. The caller
      // owns the timestamp format (RFC 3339 with millis works fine).
      return join(eventsDir, `${timestamp}-${encodeTaskId(id)}.json`);
    },
  };
}

export function ensureStateLayout(opts: ResolveOptions = {}): StateLayout {
  const root = resolveStateRoot(opts);
  const layout = layoutForRoot(root);
  // `recursive: true` makes mkdir idempotent — exactly what we want.
  // We don't need to pre-create daemon.pid / daemon.log; whoever holds
  // the daemon lock creates pidFile, and the logger creates logFile.
  mkdirSync(layout.tasksDir, { recursive: true });
  mkdirSync(layout.eventsDir, { recursive: true });
  return layout;
}
