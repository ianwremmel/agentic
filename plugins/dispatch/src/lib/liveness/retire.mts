import {hostname} from 'node:os';

import type {Database} from '../db/database.mts';
import type {Session} from '../model/types.mts';
import {SessionStore} from '../stores/session.mts';
import {probeProcessStart, sameProcess} from './liveness.mts';
import type {ProbeResult} from './liveness.mts';

/**
 * Startup retirement: delete rows carrying this session id whose server is
 * provably dead — heartbeat gone stale, pid gone, or pid reused by a
 * different process — so a server killed without cleanup (a plugin reload)
 * does not hold its claims and slots for the rest of the staleness window.
 * Deletion demands proof of death, the opposite bias from matching: a row
 * that merely cannot be verified (another host, no pid, a failed probe) is
 * left for the heartbeat sweep, and a genuinely live rival always stays —
 * two live servers under one session id are the `ambiguous-session` case,
 * which fails closed rather than being resolved by whichever registered
 * last. Returns the number of rows retired.
 */
export async function retireNonLive(
  db: Database,
  opts: {
    claudeSessionId: string;
    /** The caller's own registry row, never retired. */
    keep: string;
    now: string;
    staleAfterSeconds: number;
    probe?: ((pid: number) => Promise<ProbeResult>) | undefined;
    host?: string | undefined;
  }
): Promise<number> {
  const sessions = new SessionStore(db);
  const probe = opts.probe ?? probeProcessStart;
  const host = opts.host ?? hostname();
  let retired = 0;
  for (const row of await sessions.forCaller(opts.claudeSessionId)) {
    if (row.id === opts.keep) continue;
    if (!(await provenDead(row, {...opts, probe, host}))) continue;
    if (await sessions.close(row.id)) retired += 1;
  }
  return retired;
}

async function provenDead(
  row: Session,
  opts: {
    now: string;
    staleAfterSeconds: number;
    probe: (pid: number) => Promise<ProbeResult>;
    host: string;
  }
): Promise<boolean> {
  const quietMs = Date.parse(opts.now) - Date.parse(row.heartbeatAt);
  if (Number.isFinite(quietMs) && quietMs > opts.staleAfterSeconds * 1_000) {
    return true;
  }
  if (row.host !== opts.host || row.pid === null) return false;
  const probed = await opts.probe(row.pid);
  if (probed === 'absent') return true;
  if (probed === 'unknown') return false;
  // A running pid whose start does not match the registration is a reused
  // pid: the registered server is gone. An unreadable registered instant
  // proves nothing either way, and sameProcess already reports it as a
  // non-match, so require a readable one before treating mismatch as death.
  return (
    Number.isFinite(Date.parse(row.startedAt)) &&
    !sameProcess(probed, row.startedAt)
  );
}
