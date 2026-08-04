import {execFile} from 'node:child_process';
import {hostname} from 'node:os';
import {promisify} from 'node:util';

import type {Session} from '../model/types.mts';

const exec = promisify(execFile);

/**
 * Slack when comparing a probed process start against the row's registered
 * one: `ps -o etime=` has second granularity and the two readings happen at
 * different moments. Kept small deliberately — a wider window would tolerate
 * larger clock steps, but it would also accept a pid reused by a process
 * that started near the registered instant, and a false "live" strands a
 * session where a false "dead" only costs polling.
 */
const START_SLACK_MS = 2_000;

/**
 * What a probe learned about the process at `pid`: its start instant (epoch
 * ms), `absent` when no such process exists, or `unknown` when the probe
 * itself failed — `ps` missing or broken, or output it could not parse. The
 * three-way split matters because matching and retiring lean opposite ways:
 * a match needs proof of life, retirement needs proof of death, and
 * `unknown` provides neither.
 */
export type ProbeResult = number | 'absent' | 'unknown';

/** Parse `ps -o etime=` output — `[[dd-]hh:]mm:ss` — into seconds. */
export function parseEtime(raw: string): number | null {
  const match = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/u.exec(raw.trim());
  if (match === null) return null;
  const [, days, hours, minutes, seconds] = match;
  return (
    Number(days ?? 0) * 86_400 +
    Number(hours ?? 0) * 3_600 +
    Number(minutes) * 60 +
    Number(seconds)
  );
}

/**
 * The start instant this very process would register: what its pid must
 * verify against when a later caller probes it.
 */
export function processStartIso(): string {
  return new Date(Date.now() - process.uptime() * 1_000).toISOString();
}

/**
 * POSIX `etime` rather than procps's `etimes`: macOS `ps` has no `etimes`
 * keyword and would exit nonzero on every probe. `ps` rather than
 * `process.kill(pid, 0)` because it also sees processes owned by other
 * users, where the signal probe reports EPERM.
 */
export async function probeProcessStart(pid: number): Promise<ProbeResult> {
  try {
    const {stdout} = await exec('ps', ['-o', 'etime=', '-p', String(pid)]);
    const elapsed = parseEtime(stdout);
    return elapsed === null ? 'unknown' : Date.now() - elapsed * 1_000;
  } catch (error) {
    // A string code (ENOENT, a spawn failure) is a failed probe. A numeric
    // exit is how `ps` reports a missing pid — but an operationally broken
    // `ps` exits nonzero too, so only trust "absent" once `ps` demonstrably
    // works on this very process.
    if (typeof (error as {code?: unknown}).code !== 'number') return 'unknown';
    try {
      const {stdout} = await exec('ps', [
        '-o',
        'etime=',
        '-p',
        String(process.pid),
      ]);
      return parseEtime(stdout) === null ? 'unknown' : 'absent';
    } catch {
      return 'unknown';
    }
  }
}

/**
 * Whether a probed start instant identifies the process registered on the
 * row — servers record their own process start as `started_at`. False on an
 * unparseable registered instant: identity that cannot be read cannot be
 * confirmed.
 */
export function sameProcess(probedStartMs: number, startedAt: string): boolean {
  const registered = Date.parse(startedAt);
  return (
    Number.isFinite(registered) &&
    Math.abs(probedStartMs - registered) <= START_SLACK_MS
  );
}

/**
 * Keep only rows whose server process this one can vouch for: same host, a
 * recorded pid, and a running process whose start matches the registered
 * one (which rules out a reused pid). This is the other half of liveness
 * beside heartbeat freshness — a server killed without cleanup (a plugin
 * reload) stops heartbeating, but its row would otherwise stay "live" for
 * the whole staleness window, holding its session ambiguous. Rows that
 * cannot pass the check — another host, no pid recorded, a failed probe —
 * are dropped too: reporting a server the caller cannot verify risks a
 * false `active`, which strands a session yielding for events that never
 * arrive, where a false `inactive` only costs polling.
 */
export async function withLiveProcesses(
  sessions: Session[],
  opts?: {
    probe?: ((pid: number) => Promise<ProbeResult>) | undefined;
    host?: string | undefined;
  }
): Promise<Session[]> {
  const probe = opts?.probe ?? probeProcessStart;
  const host = opts?.host ?? hostname();
  const live: Session[] = [];
  for (const session of sessions) {
    if (session.host !== host || session.pid === null) continue;
    const probed = await probe(session.pid);
    if (typeof probed !== 'number') continue;
    if (!sameProcess(probed, session.startedAt)) continue;
    live.push(session);
  }
  return live;
}
