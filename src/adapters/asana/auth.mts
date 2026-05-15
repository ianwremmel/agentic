export interface AuthOptions {
  env?: NodeJS.ProcessEnv;
  /** Pre-resolved PAT. */
  pat?: string;
  /** Override the config lookup for tests / programmatic callers. */
  configLookup?: () => Promise<string | undefined>;
}

/**
 * Resolve an Asana Personal Access Token.
 *
 *   1. Explicit `pat` option
 *   2. `ASANA_PAT` env var
 *   3. Config lookup (see #23 — `asana.pat` in
 *      `~/.config/dispatch/config.json`)
 */
export async function resolveAsanaPat(opts: AuthOptions = {}): Promise<string> {
  if (typeof opts.pat === "string" && opts.pat.length > 0) {
    return opts.pat;
  }
  const env = opts.env ?? process.env;
  const fromEnv = env.ASANA_PAT;
  if (typeof fromEnv === "string" && fromEnv.length > 0) {
    return fromEnv;
  }
  if (opts.configLookup !== undefined) {
    const fromConfig = await opts.configLookup();
    if (fromConfig !== undefined && fromConfig.length > 0) return fromConfig;
  }
  throw new Error(
    "no Asana PAT available: set ASANA_PAT or configure asana.pat",
  );
}
