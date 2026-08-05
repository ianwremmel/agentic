import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

import type {Logger} from '../logger/index.mts';

const run = promisify(execFile);

/**
 * The login the agent writes as, from `gh`. The watch diff drops activity
 * attributable to this account: waking a worker to report its own comment is
 * the failure mode that makes server-side waiting worse than the in-band
 * polling it replaces.
 *
 * A failed lookup returns null, which fires on everything — noisier, but it
 * never silently drops a reviewer's reply, which is the error that strands a
 * PR.
 */
export async function selfLogin(log?: Logger): Promise<string | null> {
  try {
    const {stdout} = await run('gh', ['api', 'user', '--jq', '.login']);
    const login = stdout.trim();
    return login === '' ? null : login;
  } catch (error) {
    log?.warn(
      'could not resolve the agent login; watches will not filter own activity',
      {
        error: error instanceof Error ? error.message : String(error),
      }
    );
    return null;
  }
}
