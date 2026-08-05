import type {Database} from '../db/database.mts';
import {nowIso} from '../db/time.mts';
import {DataError, ensure} from '../errors/index.mts';
import {DEFAULT_STALE_AFTER_SECONDS} from '../graph/index.mts';
import {withLiveProcesses} from '../liveness/index.mts';
import {SessionStore} from '../stores/index.mts';

/**
 * The session a caller's writes should ride: an explicit registry id, else
 * the one live server carrying this environment's Claude session id. Slots
 * recorded under it cascade away if that server dies.
 */
export async function resolveSession(
  db: Database,
  env: NodeJS.ProcessEnv,
  explicit: string | undefined
): Promise<string> {
  if (explicit !== undefined) return explicit;
  const caller = env.CLAUDE_CODE_SESSION_ID ?? null;
  const live =
    caller === null
      ? []
      : await withLiveProcesses(
          await new SessionStore(db).liveForCaller(
            caller,
            nowIso(),
            DEFAULT_STALE_AFTER_SECONDS
          )
        );
  const only = live.length === 1 ? live[0] : undefined;
  ensure(
    only !== undefined,
    () =>
      new DataError('no live server correlates to this session', {
        hint: 'pass --session with the registry id from the probe event, or start the dispatch MCP server.',
      })
  );
  return only.id;
}
