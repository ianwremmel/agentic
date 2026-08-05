import {AbstractCommand} from '../lib/command/index.mts';
import type {CommandContext, Io, ParsedOptions} from '../lib/command/index.mts';
import {DB_OPTION, nowIso, withDatabase} from '../lib/db/index.mts';
import {DataError, ensure} from '../lib/errors/index.mts';
import {META_KEY, drainInstructions} from '../lib/mcp/index.mts';
import type {ChannelSink} from '../lib/mcp/index.mts';
import {Scheduler, resolveSession} from '../lib/schedule/index.mts';

const options = {
  session: {
    type: 'string',
    description:
      'Registry id to schedule under; defaults to the session correlated from the environment.',
    positional: false,
    required: false,
  },
  'max-parallel': {
    type: 'number',
    description:
      'Compute-slot ledger size this tick admits against. Match the value the MCP server was started with when that was customized.',
    positional: false,
    required: false,
  },
  db: DB_OPTION,
} as const;

function escapeAttr(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('"', '&quot;');
}

/**
 * A body must stay inside its one-line frame: `<` and `&` are escaped so a
 * body can never open or close a tag, and newlines collapse to spaces so one
 * event is always one physical line.
 */
function escapeBody(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll(/\s*\n\s*/gu, ' ');
}

/**
 * Prints each event as one `<event kind="…" …>body</event>` line, enforcing
 * the same meta invariants as `ChannelWriter`: reserved keys (`kind`, `seq`,
 * `source`) and keys outside the meta-key shape are dropped, never emitted.
 */
export class EventPrinter implements ChannelSink {
  readonly #io: Io;
  #count = 0;

  constructor(io: Io) {
    this.#io = io;
  }

  get count(): number {
    return this.#count;
  }

  push(
    kind: string,
    meta: Readonly<Record<string, string | null>>,
    content: string
  ): void {
    this.#count += 1;
    const attrs = Object.entries(meta)
      .filter(
        ([key, value]) =>
          value !== null &&
          key !== 'kind' &&
          key !== 'seq' &&
          key !== 'source' &&
          META_KEY.test(key)
      )
      .map(([key, value]) => ` ${key}="${escapeAttr(String(value))}"`)
      .join('');
    this.#io.write(
      `<event kind="${escapeAttr(kind)}"${attrs}>${escapeBody(content)}</event>\n`
    );
  }
}

/**
 * The fallback-mode counterpart of the server's timer tick: one scheduler
 * pass whose events go to stdout instead of the channel. Because the caller
 * reads the output synchronously, delivery is proven by the call itself and
 * the channel acknowledgement is not required — this is what lets a session
 * whose runner refused the channel still get claimed, budget-bounded work
 * orders instead of improvising from `dispatch queue`.
 */
export class Command extends AbstractCommand {
  readonly name = 'tick';
  readonly summary =
    'Run one scheduler pass and print the events the channel would push.';
  readonly env = [];
  readonly options = options;
  override readonly transports = {mcp: false};

  async run(
    parsed: ParsedOptions<typeof options>,
    ctx: CommandContext
  ): Promise<void> {
    const printer = new EventPrinter(ctx.io);

    // Session resolution and the scheduler pass run before the drain, so a
    // caller that fails to correlate cannot have marked any instruction
    // delivered on the way to its error.
    const orders = await withDatabase(parsed.db, ctx.env, async (db) => {
      const session = await resolveSession(db, ctx.env, parsed.session);
      const scheduler = new Scheduler(db, {
        session,
        maxParallel: parsed['max-parallel'],
        requireAck: false,
      });
      const result = await scheduler.tick(nowIso());
      ensure(
        !result.retired,
        () =>
          new DataError('the server registry row for this session is retired', {
            hint: 'the server was retired mid-tick; restart the session so a fresh server registers.',
          })
      );
      return result.orders;
    });

    // Ingest instructions print before the orders — the same delivery order
    // as the server tick.
    await drainInstructions(printer, ctx.env, {dbPath: parsed.db});
    for (const order of orders)
      printer.push(order.kind, order.meta, order.body);

    if (printer.count === 0) ctx.io.write('nothing due\n');
  }
}
