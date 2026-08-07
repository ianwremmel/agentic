import {AbstractCommand} from '../../lib/command/index.mts';
import type {CommandContext, ParsedOptions} from '../../lib/command/index.mts';
import {DB_OPTION, nowIso, withDatabase} from '../../lib/db/index.mts';
import {DataError, ensure} from '../../lib/errors/index.mts';
import {DEFAULT_STALE_AFTER_SECONDS} from '../../lib/graph/index.mts';
import {correlateSession} from '../../lib/schedule/index.mts';
import {CoordinationStore} from '../../lib/stores/index.mts';

const options = {
  db: DB_OPTION,
} as const;

/**
 * Judge a worker launch: read the would-be worker's prompt on stdin and pass
 * only if it names a node this session holds a live claim on.
 *
 * This is the deterministic half of the PreToolUse hook. The hook itself
 * decides nothing — it forwards the prompt here and relays the verdict — so
 * the rule lives in the CLI where it is tested, versioned, and shared with
 * `claim check`.
 *
 * Matching is by whole token against the session's own live claims, not by
 * parsing the prompt: the claims are few and their ids unique, while prompt
 * shapes change. A prompt that names none of them is a launch the scheduler
 * never authorized, whoever composed it. A prompt that names a claimed node
 * while instructing work on another passes here — the worker's own
 * `claim check` on the node it actually works is the layer that catches
 * that, and this hook exists to stop wholesale unbudgeted launches, not to
 * parse intent.
 *
 * CLI-only: it reads the prompt from stdin, and the hook runs in a shell.
 */
export class Command extends AbstractCommand {
  readonly name = 'guard';
  readonly summary =
    'Pass iff stdin names a node this session holds a live claim on.';
  readonly env = [];
  readonly options = options;
  override readonly transports = {mcp: false};

  async run(
    parsed: ParsedOptions<typeof options>,
    ctx: CommandContext
  ): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk as Buffer);
    }
    const prompt = Buffer.concat(chunks).toString('utf8');

    await withDatabase(parsed.db, ctx.env, async (db) => {
      const session = await correlateSession(db, ctx.env, undefined);
      ensure(
        session !== null,
        () =>
          new DataError('no live server correlates to this session', {
            hint: 'a worker launch is authorized by a claim, and only a session with a live server can hold one.',
          })
      );
      const held = (
        await new CoordinationStore(db).liveClaims({
          now: nowIso(),
          staleAfterSeconds: DEFAULT_STALE_AFTER_SECONDS,
        })
      ).filter((claim) => claim.session === session);
      // Whole-token match, not substring: a claim on CLC-7 must not
      // authorize a launch for CLC-77. A node id is bounded by any character
      // that cannot appear inside one.
      const boundary = /[A-Za-z0-9/#_.-]/u;
      const named = held.find((claim) => {
        let from = 0;
        for (;;) {
          const at = prompt.indexOf(claim.node, from);
          if (at === -1) return false;
          const before = prompt.slice(Math.max(0, at - 1), at);
          const afterIndex = at + claim.node.length;
          const after = prompt.slice(afterIndex, afterIndex + 1);
          if (!boundary.test(before) && !boundary.test(after)) return true;
          from = at + 1;
        }
      });
      ensure(
        named !== undefined,
        () =>
          new DataError(
            'the launch prompt names no node this session holds a claim on',
            {
              hint: 'workers are launched from work orders, which name a node the scheduler already claimed. Wait for a work order instead of composing a launch.',
            }
          )
      );
      ctx.io.write(`guard pass ${named.node}\n`);
    });
  }
}
