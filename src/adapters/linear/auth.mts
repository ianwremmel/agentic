export interface AuthOptions {
  env?: NodeJS.ProcessEnv;
  /** Pre-resolved API key. */
  apiKey?: string;
  /** Override the config lookup for tests / programmatic callers. */
  configLookup?: () => Promise<string | undefined>;
}

/**
 * Resolve a Linear API key.
 *
 *   1. Explicit `apiKey` option (callers that already loaded it)
 *   2. `LINEAR_API_KEY` env var
 *   3. Config lookup (see #23 — `linear.apiKey` in
 *      `~/.config/dispatch/config.json`)
 */
export async function resolveLinearApiKey(
  opts: AuthOptions = {},
): Promise<string> {
  if (typeof opts.apiKey === "string" && opts.apiKey.length > 0) {
    return opts.apiKey;
  }
  const env = opts.env ?? process.env;
  const fromEnv = env.LINEAR_API_KEY;
  if (typeof fromEnv === "string" && fromEnv.length > 0) {
    return fromEnv;
  }
  if (opts.configLookup !== undefined) {
    const fromConfig = await opts.configLookup();
    if (fromConfig !== undefined && fromConfig.length > 0) return fromConfig;
  }
  throw new Error(
    "no Linear API key available: set LINEAR_API_KEY or configure linear.apiKey",
  );
}
