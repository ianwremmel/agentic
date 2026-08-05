import {randomUUID} from 'node:crypto';
import {hostname} from 'node:os';

import {AbstractCommand, discover} from '../lib/command/index.mts';
import type {ParsedOptions, CommandContext} from '../lib/command/index.mts';
import {nowIso, withDatabase} from '../lib/db/index.mts';
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
    const tree = await discover(new URL('./', import.meta.url));

    const registryId = randomUUID();
    const startedAt = nowIso();
    await withDatabase(undefined, ctx.env, async (db) =>
      new SessionStore(db).register({
        id: registryId,
        host: hostname(),
        pid: process.pid,
        claudeSessionId: ctx.env.CLAUDE_CODE_SESSION_ID ?? null,
        startedAt,
        heartbeatAt: startedAt,
      })
    );

    const state = createTickState(registryId, parsed['max-parallel']);
    try {
      await runMcpServer({
        tree,
        stdin: process.stdin,
        stdout: process.stdout,
        stderr: process.stderr,
        env: ctx.env,
        tick: {
          intervalMs: parsed['tick-seconds'] * 1_000,
          run: (channel) =>
            runServerTick(channel, ctx.env, state, {log: ctx.log}),
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
