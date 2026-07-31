import {readFile as fsReadFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';

/** The plugin whose userConfig holds `operator_login`, as keyed in settings. */
export const PLUGIN_NAME = 'land';

/** Read a settings file, or `undefined` when it is absent or unreadable. */
export type ReadFile = (path: string) => Promise<string | undefined>;

/** The default {@link ReadFile}: node fs, with any read failure folded to absent. */
export const fsRead: ReadFile = async (path) => {
  try {
    return await fsReadFile(path, 'utf8');
  } catch {
    return undefined;
  }
};

export interface OperatorResolution {
  /** The resolved login, or undefined when no source carried one. */
  readonly login: string | undefined;
  /** Non-fatal notes (e.g. an unparseable settings file that was skipped). */
  readonly warnings: readonly string[];
}

export interface ResolveOperatorOptions {
  readonly env: NodeJS.ProcessEnv;
  /** Injected for tests; defaults to reading the real filesystem. */
  readonly readFile?: ReadFile;
  /** Root of the repo, used to find its `.claude` settings. */
  readonly projectRoot: string;
}

/**
 * Resolve the operator's GitHub login. The env var wins when set (a hook
 * process gets it injected; a caller may also export it). Otherwise read it
 * from the settings files Claude Code itself reads, in Claude Code's precedence
 * order — first match wins. The plugin key is matched as `land` or
 * `land@<marketplace>`, since the marketplace name is chosen at install time.
 *
 * A settings file that exists but does not parse is recorded as a warning and
 * skipped, rather than silently handing the answer to a lower-precedence file.
 */
export async function resolveOperatorLogin({
  env,
  readFile = fsRead,
  projectRoot,
}: ResolveOperatorOptions): Promise<OperatorResolution> {
  const injected = env.CLAUDE_PLUGIN_OPTION_OPERATOR_LOGIN;
  if (injected !== undefined && injected !== '') {
    return {login: injected, warnings: []};
  }

  const home = env.HOME !== undefined && env.HOME !== '' ? env.HOME : homedir();
  const files = [
    '/etc/claude-code/managed-settings.json',
    '/Library/Application Support/ClaudeCode/managed-settings.json',
    join(projectRoot, '.claude', 'settings.local.json'),
    join(projectRoot, '.claude', 'settings.json'),
    join(home, '.claude', 'settings.json'),
  ];

  const warnings: string[] = [];
  for (const file of files) {
    const raw = await readFile(file);
    if (raw === undefined) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      warnings.push(
        `could not parse ${file}; skipping it for operator_login resolution`
      );
      continue;
    }

    const login = operatorLoginFrom(parsed);
    if (login !== undefined) return {login, warnings};
  }

  return {login: undefined, warnings};
}

/** Pull the first `land`/`land@*` plugin's non-empty operator_login from settings. */
function operatorLoginFrom(settings: unknown): string | undefined {
  if (typeof settings !== 'object' || settings === null) return undefined;
  const configs = (settings as Record<string, unknown>).pluginConfigs;
  if (typeof configs !== 'object' || configs === null) return undefined;

  for (const [key, value] of Object.entries(configs)) {
    if (key !== PLUGIN_NAME && !key.startsWith(`${PLUGIN_NAME}@`)) continue;
    if (typeof value !== 'object' || value === null) continue;
    const options = (value as Record<string, unknown>).options;
    if (typeof options !== 'object' || options === null) continue;
    const login = (options as Record<string, unknown>).operator_login;
    if (typeof login === 'string' && login !== '') return login;
  }
  return undefined;
}

/**
 * Where the per-PR cache lives: `<base>/deliver/<owner>__<repo>/<pr>`. The base
 * is `$LAND_CACHE_DIR`, else `$XDG_CACHE_HOME/land`, else `~/.cache/land`. The
 * caller need not know the layout — pr-status emits each cache file's absolute
 * path in the XML.
 */
export function resolveCacheDir(
  env: NodeJS.ProcessEnv,
  repo: string,
  pr: string
): string {
  const base =
    nonEmpty(env.LAND_CACHE_DIR) ??
    join(nonEmpty(env.XDG_CACHE_HOME) ?? join(homedir(), '.cache'), 'land');
  const slug = repo.replaceAll('/', '__');
  return join(base, 'deliver', slug, pr);
}

/** A regex source matching check names to treat as non-blocking, or ''. */
export function informationalPattern(env: NodeJS.ProcessEnv): string {
  return nonEmpty(env.LAND_INFORMATIONAL_CHECKS) ?? '';
}

/** Seconds after which an in-progress check is presumed stuck. */
export function stuckAfterSeconds(env: NodeJS.ProcessEnv): number {
  const raw = nonEmpty(env.LAND_STUCK_AFTER_SEC);
  if (raw === undefined) return 3600;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 3600;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value !== '' ? value : undefined;
}
