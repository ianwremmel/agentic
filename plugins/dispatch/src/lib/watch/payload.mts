import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

import type {Logger} from '../logger/index.mts';

const run = promisify(execFile);

/**
 * How long one payload read may take before the tick moves on without it.
 *
 * This bounds a heartbeat, not just a read. Payload reads happen inside the
 * tick, and a session whose heartbeat stops for the staleness window is swept
 * — its claims cascade and its work is re-dispatched underneath it. The
 * budget below keeps the worst case an order of magnitude short of that.
 */
const TIMEOUT_MS = 20_000;

/**
 * The `pr-status` payload for a PR, which is what a PR/CI event body must
 * carry: the worker then reacts to everything the tick saw in one turn, from
 * the same document it would have read itself.
 *
 * `--repo` is what makes this reachable from the server, which stands in one
 * directory and watches PRs across repos.
 *
 * A failed read returns null rather than failing the tick. The event still
 * goes out with its summary, and the worker reads `pr-status` itself — a
 * degraded wake-up beats a silent one.
 */
export async function prStatusPayload(
  repo: string,
  prNumber: number,
  opts: {script: string; log?: Logger | undefined}
): Promise<string | null> {
  try {
    const {stdout} = await run(
      opts.script,
      ['--repo', repo, String(prNumber)],
      {timeout: TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024}
    );
    const payload = stdout.trim();
    return payload === '' ? null : payload;
  } catch (error) {
    opts.log?.warn('could not read the pr-status payload', {
      repo,
      pr: prNumber,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/** The bundled `pr-status`, resolved against this file rather than the cwd. */
export function prStatusScript(): string {
  return new URL('../../../bin/pr-status', import.meta.url).pathname;
}
