import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { isEventKind, type EventKind } from "../state/event.mts";
import { getBuiltinPrompt, type BuiltinPrompt } from "./index.mts";

/**
 * A successfully-resolved prompt template for an event. The `source` field
 * tells the caller which layer the template came from so we can log it for
 * debugging and surface it in `pr-status` introspection later on.
 */
export interface ResolvedPrompt {
  source: "repo" | "user" | "built-in";
  path: string;
  content: string;
}

/**
 * Per-layer search location. Each candidate is tried in order; the first
 * one whose file exists wins.
 */
interface PromptCandidate {
  source: "repo" | "user";
  path: string;
}

export interface ResolveOptions {
  /** Per-call override for the user-config root. Tests inject a tmpdir. */
  userConfigDir?: string;
  /** Override the env used to derive the user-config root. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Resolve the user-config root used for `<user-config>/dispatch/prompts/`.
 * Mirrors `resolveConfigPath` in src/config/load.mts but keeps prompts
 * separate from `config.json` so we can swap implementations later.
 */
function resolveUserConfigDir(
  env: NodeJS.ProcessEnv = process.env,
  override?: string,
): string {
  if (override !== undefined) return override;
  const xdg = env.XDG_CONFIG_HOME;
  if (xdg && xdg.length > 0) return join(xdg, "dispatch");
  return join(env.HOME ?? homedir(), ".config", "dispatch");
}

function candidatesFor(
  event: EventKind,
  cwd: string,
  userConfigDir: string,
): PromptCandidate[] {
  // Search order is normative: repo wins over user wins over built-in;
  // `.xml` wins over `.md` within each layer. Built-in is appended by the
  // caller via getBuiltinPrompt() after all checked candidates miss.
  return [
    { source: "repo", path: join(cwd, ".dispatch", "prompts", `${event}.xml`) },
    { source: "repo", path: join(cwd, ".dispatch", "prompts", `${event}.md`) },
    { source: "user", path: join(userConfigDir, "prompts", `${event}.xml`) },
    { source: "user", path: join(userConfigDir, "prompts", `${event}.md`) },
  ];
}

function tryRead(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    // Missing files are how the layered lookup falls through to the next
    // candidate. Any other error (permission denied, EISDIR) is a real
    // problem and should propagate to the caller.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Layered prompt template lookup. Tries, in order:
 *
 *   1. `<cwd>/.dispatch/prompts/<event>.xml`
 *   2. `<cwd>/.dispatch/prompts/<event>.md`
 *   3. `<user-config>/dispatch/prompts/<event>.xml`
 *   4. `<user-config>/dispatch/prompts/<event>.md`
 *   5. Built-in (embedded in the SEA binary, see #27).
 *
 * Throws if `event` isn't a known kind from the event taxonomy — we never
 * want a typo to fall silently through to the built-in default.
 */
export function resolvePrompt(
  event: string,
  cwd: string,
  opts: ResolveOptions = {},
): ResolvedPrompt {
  if (!isEventKind(event)) {
    throw new Error(`Unknown event kind: ${JSON.stringify(event)}`);
  }
  const userConfigDir = resolveUserConfigDir(opts.env, opts.userConfigDir);
  for (const c of candidatesFor(event, cwd, userConfigDir)) {
    const content = tryRead(c.path);
    if (content !== null) {
      return { source: c.source, path: c.path, content };
    }
  }
  const fallback: BuiltinPrompt = getBuiltinPrompt(event);
  return fallback;
}
