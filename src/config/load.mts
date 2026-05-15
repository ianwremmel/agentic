// Disk-facing config loader. Reads the resolved config path, parses
// JSON, hands the raw object to `validate`, and converts validation
// failures into DispatchError(USAGE).
//
// Path resolution:
//   $XDG_CONFIG_HOME/dispatch/config.json   if XDG_CONFIG_HOME is set
//   $HOME/.config/dispatch/config.json      otherwise
//
// Missing file = defaults, no error (per AC).

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DispatchError, ExitCode } from "../cli/errors.mts";
import { DEFAULT_CONFIG, type DispatchConfig } from "./schema.mts";
import { validate } from "./validate.mts";

export interface LoadOptions {
  /**
   * Explicit path override; bypasses XDG resolution. Used by tests
   * and (in future) by a `DISPATCH_CONFIG` env var.
   */
  path?: string;
  env?: NodeJS.ProcessEnv;
}

export function resolveConfigPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const xdg = env.XDG_CONFIG_HOME;
  if (xdg && xdg.length > 0) {
    return join(xdg, "dispatch", "config.json");
  }
  return join(env.HOME ?? homedir(), ".config", "dispatch", "config.json");
}

export function loadConfig(opts: LoadOptions = {}): DispatchConfig {
  const env = opts.env ?? process.env;
  const path = opts.path ?? resolveConfigPath(env);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    // `code` is `ENOENT` for missing files. Any other read error
    // (permissions, EISDIR, etc.) should surface — we don't want to
    // silently fall back to defaults if the user *meant* to provide a
    // file but we couldn't read it.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return DEFAULT_CONFIG;
    }
    throw new DispatchError(
      ExitCode.USAGE,
      `cannot read config at ${path}: ${(err as Error).message}`,
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new DispatchError(
      ExitCode.USAGE,
      `invalid JSON in ${path}: ${(err as Error).message}`,
    );
  }

  const result = validate(raw);
  if (!result.ok) {
    const indented = result.errors.map((e) => `  - ${e}`).join("\n");
    throw new DispatchError(
      ExitCode.USAGE,
      `invalid config at ${path}:\n${indented}`,
    );
  }
  return result.value;
}
