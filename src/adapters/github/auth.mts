import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface AuthOptions {
  /** Inspect-only env source. Default: process.env. */
  env?: NodeJS.ProcessEnv;
  /** Override the ghAuthToken function for tests. */
  ghAuthToken?: () => Promise<string | undefined>;
}

/**
 * Resolve a GitHub token.
 *
 *   1. `GITHUB_TOKEN` environment variable
 *   2. `gh auth token` (shells out)
 *
 * Throws if neither source yields a token. The token value is never
 * logged or surfaced through the error message.
 */
export async function resolveGitHubToken(
  opts: AuthOptions = {},
): Promise<string> {
  const env = opts.env ?? process.env;
  const fromEnv = env.GITHUB_TOKEN;
  if (typeof fromEnv === "string" && fromEnv.length > 0) {
    return fromEnv;
  }
  const fromGh = await (opts.ghAuthToken ?? defaultGhAuthToken)();
  if (fromGh !== undefined && fromGh.length > 0) {
    return fromGh;
  }
  throw new Error(
    "no GitHub token available: set GITHUB_TOKEN or run `gh auth login`",
  );
}

async function defaultGhAuthToken(): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("gh", ["auth", "token"], {
      timeout: 5_000,
    });
    const trimmed = stdout.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch {
    return undefined;
  }
}
