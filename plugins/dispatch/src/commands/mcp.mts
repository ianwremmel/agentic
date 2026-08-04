import {randomUUID} from 'node:crypto';
import {hostname} from 'node:os';

import {AbstractCommand, discover} from '../lib/command/index.mts';
import type {ParsedOptions, CommandContext} from '../lib/command/index.mts';
import {nowIso, withDatabase} from '../lib/db/index.mts';
import {DEFAULT_STALE_AFTER_SECONDS} from '../lib/graph/index.mts';
import {processStartIso, retireNonLive} from '../lib/liveness/index.mts';
import {runMcpServer} from '../lib/mcp/index.mts';
import {createTickState, runServerTick} from '../lib/schedule/index.mts';
import {SessionStore} from '../lib/stores/index.mts';

const options = {
  'max-parallel': {
    type: 'number',
    description: 'Compute-slot ledger size this server admits against.',
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
    await withDatabase(undefined, ctx.env, async (db) => {
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
      // The session dies with its server; claims and slots cascade so another
      // server can pick the work up through stale-free reclamation.
      await withDatabase(undefined, ctx.env, async (db) =>
        new SessionStore(db).close(registryId)
      ).catch(() => undefined);
    }
  }
}
