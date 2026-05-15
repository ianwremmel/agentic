// §2.1.2 §Mode detection — the predicate decides Mode A vs B at write
// time from credentials, not from config.
//
// This module owns the predicate's *logic* (typed identity check + name
// matching + default-to-B fallback) and the per-process cache. The actual
// "look up the viewer for these credentials" call is platform-specific —
// it is injected as a `ViewerLookup` so the GitHub / Linear / Asana
// adapters (#34–#36) can supply their own queries without this module
// depending on any platform SDK.

import type { Mode } from "./wire-format.mts";

/**
 * Identifies a platform for mode detection. The string is opaque — adapters
 * pick stable names (e.g. `"github"`, `"linear"`). The detection cache is
 * keyed by `${platform}\0${credentialFingerprint}` so a single process can
 * write to multiple platforms (and multiple accounts on each) without
 * cross-talk.
 */
export type Platform = string;

/**
 * The minimum the predicate needs back from a platform's viewer query.
 *
 * - `typedBot`: the platform classifies the account as a bot / integration
 *   / service account (e.g. GitHub's `type === "Bot"` on a user object,
 *   Linear's `viewer.isService`). Adapters MUST normalize their
 *   platform-specific signal to this boolean.
 * - `names`: any account identifier the platform surfaces — login, display
 *   name, email local-part. Adapters SHOULD include every surface they
 *   have so the name-match patterns get the best chance to fire.
 */
export interface ViewerIdentity {
  typedBot?: boolean;
  names?: readonly string[];
}

/**
 * Performs the platform-specific "who is the viewer?" lookup for the given
 * credentials. Must return `null` if it cannot determine the viewer (the
 * predicate then defaults to Mode B per §Default).
 */
export type ViewerLookup = (
  credentials: unknown,
) => Promise<ViewerIdentity | null>;

/**
 * Returns a stable string for caching this credential set. Two calls with
 * "the same credentials" must return the same fingerprint. Returning
 * `null` disables caching (each call hits the network). Adapters typically
 * fingerprint the token itself, but anything stable-and-unique works.
 */
export type CredentialFingerprint = (credentials: unknown) => string | null;

export interface DetectModeOptions {
  /**
   * Override the name-match glob list. The defaults from §Mode A signals
   * are baked in; supplying this *replaces* them. Most callers should not
   * need this.
   */
  nameMatchGlobs?: readonly string[];
  /**
   * Per-process cache. Pass a shared map across adapters to share the
   * cache. Defaults to a module-level singleton.
   */
  cache?: Map<string, Mode>;
}

const DEFAULT_NAME_GLOBS = [
  "*copilot*",
  "*codex*",
  "*claude*",
  "*ai-agent*",
] as const;

const moduleCache = new Map<string, Mode>();

/**
 * Decide Mode A vs Mode B for these credentials on this platform.
 *
 * Defaults to Mode B on any uncertainty: network failure, missing typed
 * field with no matching name, unrecognized lookup result. This matches
 * §Default verbatim: "If the identity lookup fails or the result is
 * ambiguous, the writer MUST default to Mode B."
 */
export async function detectMode(
  platform: Platform,
  credentials: unknown,
  lookup: ViewerLookup,
  fingerprint: CredentialFingerprint,
  options: DetectModeOptions = {},
): Promise<Mode> {
  const cache = options.cache ?? moduleCache;
  const fp = fingerprint(credentials);
  const cacheKey = fp === null ? null : `${platform}\u0000${fp}`;

  if (cacheKey !== null) {
    const cached = cache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }
  }

  const globs = options.nameMatchGlobs ?? DEFAULT_NAME_GLOBS;
  let mode: Mode;
  try {
    const identity = await lookup(credentials);
    mode = classify(identity, globs);
  } catch {
    mode = "B";
  }

  if (cacheKey !== null) {
    cache.set(cacheKey, mode);
  }
  return mode;
}

/**
 * For tests and `unloadCredentials`-style flows: wipe the per-process
 * decision for one or all credentials.
 */
export function clearModeCache(
  options: { cache?: Map<string, Mode> } = {},
): void {
  (options.cache ?? moduleCache).clear();
}

function classify(
  identity: ViewerIdentity | null,
  globs: readonly string[],
): Mode {
  if (identity === null) {
    return "B";
  }
  if (identity.typedBot === true) {
    return "A";
  }
  const compiled = globs.map(globToRegExp);
  for (const name of identity.names ?? []) {
    for (const re of compiled) {
      if (re.test(name)) {
        return "A";
      }
    }
  }
  return "B";
}

/**
 * Compile a glob with `*` as the only metacharacter into a
 * case-insensitive RegExp. `?`, `[`, etc. are NOT supported because the
 * spec's pattern grammar is restricted to `*<token>*`-style matchers.
 */
function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .split("*")
    .map((segment) => segment.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`, "i");
}
