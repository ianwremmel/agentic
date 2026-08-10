import {randomUUID} from 'node:crypto';
import {hostname} from 'node:os';

import {AbstractCommand, discover} from '../lib/command/index.mts';
import type {ParsedOptions, CommandContext} from '../lib/command/index.mts';
import {nowIso, withDatabase} from '../lib/db/index.mts';
import {DEFAULT_STALE_AFTER_SECONDS} from '../lib/graph/index.mts';
import {processStartIso, retireNonLive} from '../lib/liveness/index.mts';
import {runMcpServer} from '../lib/mcp/index.mts';
import {
  DEFAULT_MAX_IN_FLIGHT_BUILDS,
  DEFAULT_MAX_OPEN_PRS,
  parseRepoLimits,
} from '../lib/model/index.mts';
import {createTickState, runServerTick} from '../lib/schedule/index.mts';
import {PolicyStore, SessionStore} from '../lib/stores/index.mts';

const options = {
  'max-parallel': {
    type: 'number',
    description:
      'Cap on agents running at once, across every session sharing this database.',
    positional: false,
    required: false,
  },
  'max-open-prs': {
    type: 'number',
    description:
      'Cap on PRs open at once in one repo, for every repo without an override.',
    positional: false,
    required: false,
    default: DEFAULT_MAX_OPEN_PRS,
  },
  'max-open-prs-by-repo': {
    type: 'string',
    description:
      'Per-repo overrides of --max-open-prs, as owner/repo=<number>, comma separated.',
    positional: false,
    required: false,
  },
  'max-in-flight-builds': {
    type: 'number',
    description:
      "Cap on one repo's PRs with CI running at once, for every repo without an override.",
    positional: false,
    required: false,
    default: DEFAULT_MAX_IN_FLIGHT_BUILDS,
  },
  'max-in-flight-builds-by-repo': {
    type: 'string',
    description:
      'Per-repo overrides of --max-in-flight-builds, as owner/repo=<number>, comma separated.',
    positional: false,
    required: false,
  },
  'tick-seconds': {
    type: 'number',
    description: 'Scheduler tick interval.',
    positional: false,
    required: false,
    default: 15,
  },
} as const;

export class Command extends AbstractCommand {
  readonly name = 'mcp';
  readonly summary = 'Start the MCP server on stdio.';
  readonly env = [];
  readonly options = options;
  override readonly transports = {mcp: false};

  async run(
    parsed: ParsedOptions<typeof options>,
    ctx: CommandContext
  ): Promise<void> {
    // Registration precedes everything else, command discovery included — it
    // needs only the DB, and a skill invoked on the session's first turn
    // would otherwise correlate to nothing. `started_at` records this
    // process's own start: the identity a later liveness probe verifies the
    // registered pid against.
    const registryId = randomUUID();
    const registeredAt = nowIso();
    const claudeSessionId = ctx.env.CLAUDE_CODE_SESSION_ID ?? null;
    // Parsed before anything is written: a malformed override list is a usage
    // error, not a server that starts and then enforces half a policy.
    const repoCaps = {
      openPrs: parsed['max-open-prs'],
      inFlightBuilds: parsed['max-in-flight-builds'],
      openPrsByRepo: parseRepoLimits(
        parsed['max-open-prs-by-repo'] ?? '',
        'max-open-prs-by-repo'
      ),
      inFlightBuildsByRepo: parseRepoLimits(
        parsed['max-in-flight-builds-by-repo'] ?? '',
        'max-in-flight-builds-by-repo'
      ),
    };
    await withDatabase(undefined, ctx.env, async (db) => {
      // The caps bound the host's shared resources, so the policy lives in the
      // database where every reader — this server's scheduler, and `dispatch
      // status` in another process — sees the same one.
      await new PolicyStore(db).setRepoCaps(repoCaps);
      await new SessionStore(db).register({
        id: registryId,
        host: hostname(),
        pid: process.pid,
        claudeSessionId,
        startedAt: processStartIso(),
        heartbeatAt: registeredAt,
      });
      // Rows for this session whose server died without cleanup (a plugin
      // reload) would otherwise hold their claims and slots until their
      // heartbeat ages out; retire them now. Live rows stay — two live
      // servers under one session id fail closed as ambiguous rather than
      // being resolved by whichever registered last.
      if (claudeSessionId !== null) {
        await retireNonLive(db, {
          claudeSessionId,
          keep: registryId,
          now: registeredAt,
          staleAfterSeconds: DEFAULT_STALE_AFTER_SECONDS,
        });
      }
    });

    // Everything past registration runs under the finally: a startup
    // failure — discovery included — must retire the row it just created,
    // not strand it until the heartbeat sweep.
    try {
      const tree = await discover(new URL('./', import.meta.url));
      const state = createTickState(registryId, parsed['max-parallel']);
      await runMcpServer({
        tree,
        stdin: process.stdin,
        stdout: process.stdout,
        stderr: process.stderr,
        env: ctx.env,
        tick: {
          intervalMs: parsed['tick-seconds'] * 1_000,
          run: (channel) => runServerTick(channel, ctx.env, state),
        },
      });
    } finally {
      // The session dies with its server; claims cascade so another
      // server can pick the work up through stale-free reclamation.
      await withDatabase(undefined, ctx.env, async (db) =>
        new SessionStore(db).close(registryId)
      ).catch(() => undefined);
    }
  }
}
