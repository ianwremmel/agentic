import type {Database} from '../db/database.mts';
import {nowIso} from '../db/time.mts';
import {DataError, ensure} from '../errors/index.mts';
import {DEFAULT_STALE_AFTER_SECONDS} from '../graph/index.mts';
import {withLiveProcesses} from '../liveness/index.mts';
import {SessionStore} from '../stores/index.mts';

/**
 * Correlate a caller to its server without demanding one exists.
 *
 * `null` means no live server rides this caller's session — an operator at a
 * terminal, or a session whose server died. A command that only wanted to
 * release its own claim can proceed: there is no claim of its own to release.
 *
 * Ambiguity is emphatically not that case. More than one live server carries
 * this session id, so which one's claim a release should target is unknowable,
 * and guessing would either strand capacity or revoke a running worker's grant.
 * That throws, naming `--session` as the way out.
 */
export async function correlateSession(
  db: Database,
  env: NodeJS.ProcessEnv,
  explicit: string | undefined
): Promise<string | null> {
  if (explicit !== undefined) return explicit;
  const caller = env.CLAUDE_CODE_SESSION_ID ?? null;
  if (caller === null) return null;
  const live = await withLiveProcesses(
    await new SessionStore(db).liveForCaller(
      caller,
      nowIso(),
      DEFAULT_STALE_AFTER_SECONDS
    )
  );
  ensure(
    live.length <= 1,
    () =>
      new DataError(
        `${String(live.length)} live servers carry this session id: ${live
          .map((session) => session.id)
          .join(', ')}`,
        {
          hint: 'pass --session with the registry id from the probe event; correlation cannot choose between them.',
        }
      )
  );
  return live[0]?.id ?? null;
}

/**
 * The session a caller's writes must ride. Claims recorded under it cascade
 * away if that server dies. Unlike `correlateSession`, having no server at all
 * is a failure — the caller needs a session to write under.
 */
export async function resolveSession(
  db: Database,
  env: NodeJS.ProcessEnv,
  explicit: string | undefined
): Promise<string> {
  const session = await correlateSession(db, env, explicit);
  ensure(
    session !== null,
    () =>
      new DataError('no live server correlates to this session', {
        hint: 'pass --session with the registry id from the probe event, or start the dispatch MCP server.',
      })
  );
  return session;
}
