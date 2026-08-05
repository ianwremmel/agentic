import {setTimeout as sleep} from 'node:timers/promises';

import {AbstractCommand} from '../../lib/command/index.mts';
import type {CommandContext, ParsedOptions} from '../../lib/command/index.mts';
import {DB_OPTION, nowIso, withDatabase} from '../../lib/db/index.mts';
import {DataError, assertUsage, ensure} from '../../lib/errors/index.mts';
import {
  DEFAULT_MAX_PARALLEL,
  resolveSession,
} from '../../lib/schedule/index.mts';
import {CoordinationStore} from '../../lib/stores/index.mts';

const options = {
  actor: {
    type: 'string',
    description:
      'The id of the node being worked (the PR item, ticket, or milestone). The scheduler counts a claim and its slot as one obligation only when they name the same node.',
    positional: false,
    required: true,
  },
  session: {
    type: 'string',
    description:
      'Registry id owning the slot; defaults to the session correlated from the environment.',
    positional: false,
    required: false,
  },
  max: {
    type: 'number',
    description: 'Ledger size.',
    positional: false,
    required: false,
  },
  'timeout-seconds': {
    type: 'number',
    description:
      'How long to keep waiting for a slot before failing. Keep under the Bash tool timeout and re-run on failure for longer waits.',
    positional: false,
    required: false,
    default: 540,
  },
  'interval-seconds': {
    type: 'number',
    description: 'Ledger re-check interval while full.',
    positional: false,
    required: false,
    default: 5,
  },
  db: DB_OPTION,
} as const;

/**
 * The blocking form of `slot acquire`: the ledger polling happens here, in
 * one foreground call, instead of in an agent's retry loop — a worker that
 * waits through a background monitor or a stop/notify cycle wakes its whole
 * session every interval. CLI-only: the MCP server handles requests
 * sequentially, so a blocking tool call would stall every other worker's
 * tool calls behind it.
 */
export class Command extends AbstractCommand {
  readonly name = 'wait';
  readonly summary = 'Block until a compute slot is acquired, or time out.';
  readonly env = [];
  readonly options = options;
  override readonly transports = {mcp: false};

  async run(
    parsed: ParsedOptions<typeof options>,
    ctx: CommandContext
  ): Promise<void> {
    assertUsage(
      parsed['timeout-seconds'] > 0,
      '--timeout-seconds must be positive'
    );
    assertUsage(
      parsed['interval-seconds'] > 0,
      '--interval-seconds must be positive'
    );
    const deadline = Date.now() + parsed['timeout-seconds'] * 1_000;
    for (;;) {
      const result = await withDatabase(parsed.db, ctx.env, async (db) => {
        const session = await resolveSession(db, ctx.env, parsed.session);
        return new CoordinationStore(db).acquireSlot({
          session,
          actor: parsed.actor,
          max: parsed.max ?? DEFAULT_MAX_PARALLEL,
          acquiredAt: nowIso(),
        });
      });
      if (result !== 'full') {
        ctx.io.write(`slot ${result} ${parsed.actor}\n`);
        return;
      }
      const remainingMs = deadline - Date.now();
      ensure(
        remainingMs > 0,
        () =>
          new DataError('the compute ledger stayed full past the timeout', {
            hint: 'every slot is still held; re-run `dispatch slot wait` to keep waiting, or release a slot this session holds.',
          })
      );
      await sleep(Math.min(parsed['interval-seconds'] * 1_000, remainingMs));
    }
  }
}
