import {hostname} from 'node:os';

import type {Database} from '../db/database.mts';
import {nowIso} from '../db/time.mts';
import {DataError, ensure} from '../errors/index.mts';
import {DEFAULT_STALE_AFTER_SECONDS} from '../graph/index.mts';
import {SessionStore} from '../stores/index.mts';
import type {Session} from '../model/index.mts';

/**
 * Whether the process a session row registered is still running on this host.
 * A row registered on another host, or without a pid, cannot be checked and
 * passes — the error is conservative only where a check is possible: a dead
 * server's fresh-looking row must not be resolved, because callers like
 * `dispatch tick` heartbeat the row they resolve and would otherwise keep a
 * ghost session live forever, its claims never going stale.
 */
function processLooksAlive(session: Session): boolean {
  if (session.host === null || session.host !== hostname()) return true;
  if (session.pid === null) return true;
  try {
    process.kill(session.pid, 0);
    return true;
  } catch (error) {
    // EPERM means the pid exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

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
  const live = (
    caller === null
      ? []
      : await new SessionStore(db).liveForCaller(
          caller,
          nowIso(),
          DEFAULT_STALE_AFTER_SECONDS
        )
  ).filter(processLooksAlive);
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
