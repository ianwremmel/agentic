import assert from 'node:assert';

import {parseArgsOrUsage} from '../lib/args.mts';
import type {Command, CommandContext} from '../lib/command.mts';
import {assertUsage, UsageError} from '../lib/errors.mts';
import {resolveDbPath} from '../lib/graph/config.mts';
import {attr} from '../lib/graph/document.mts';
import {writeLine} from '../lib/io.mts';
import {group} from '../lib/subcommand.mts';
import {
  isWaitKind,
  WAIT_KINDS,
  WaitStore,
  type WaitStats,
} from '../lib/wait/store.mts';

const DB_USAGE =
  '  --db <path>      Dispatch database (default: $DISPATCH_GRAPH_DB, else $XDG_STATE_HOME/dispatch/graph.db).';

const REPO_USAGE =
  '  --repo <slug>    The repository, as owner/repo (required).';

/**
 * Per-repo wait history: the delivery agent's project memory for tuning its
 * polling schedule, persisted and computed by the CLI so no agent keeps a
 * history file or does the arithmetic.
 */
const record: Command = {
  name: 'record',
  summary: 'Record one observed wait (CI, reviewer, or merge) for a repo.',
  usage: [
    'dispatch wait record --repo owner/repo --kind ci --elapsed 340 [--outcome passed]',
    '',
    "Prints the kind's stats with the new sample included:",
    '  <wait repo="owner/repo" kind="ci" count="12" median-s="340"/>',
    'History is capped at 100 samples per (repo, kind); older ones drop off.',
    '',
    'options:',
    REPO_USAGE,
    `  --kind <k>       One of: ${WAIT_KINDS.join(', ')} (required).`,
    '  --elapsed <s>    How long the wait took, in whole seconds (required).',
    '  --outcome <w>    Short note on how it ended (e.g. passed, approved).',
    DB_USAGE,
  ].join('\n'),

  async run(argv, context) {
    const {values} = parseArgsOrUsage({
      args: argv,
      options: {
        db: {type: 'string'},
        repo: {type: 'string'},
        kind: {type: 'string'},
        elapsed: {type: 'string'},
        outcome: {type: 'string'},
      },
      allowPositionals: false,
      strict: true,
    });
    const repo = requireRepo(values.repo, 'wait record');
    const kind = values.kind ?? '';
    assert(
      isWaitKind(kind),
      new UsageError(`"${kind}" is not a wait kind`, {
        hint: `use --kind with one of: ${WAIT_KINDS.join(', ')}.`,
      })
    );
    assertUsage(
      values.elapsed !== undefined,
      'wait record needs --elapsed (the wait in seconds)'
    );
    const elapsedS = Number(values.elapsed);
    assert(
      Number.isInteger(elapsedS) && elapsedS >= 0,
      new UsageError(
        `--elapsed must be a non-negative whole number of seconds, not "${values.elapsed}"`,
        {hint: 'e.g. --elapsed 340.'}
      )
    );

    await withWaitStore(values.db, context, async (store) => {
      const stats = await store.record(
        {repo, kind, elapsedS, outcome: values.outcome ?? null},
        Date.now()
      );
      await writeLine(context.stdout, statsXml(repo, stats));
      await context.log.info('recorded wait', {
        repo,
        kind,
        elapsedS,
        count: stats.count,
      });
    });
  },
};

const stats: Command = {
  name: 'stats',
  summary: "Print a repo's wait history stats, per kind.",
  usage: [
    'dispatch wait stats --repo owner/repo',
    '',
    'One line per kind the repo has samples of (none yet: no lines):',
    '  <wait repo="owner/repo" kind="ci" count="12" median-s="340"/>',
    'Tune the polling schedule from median-s: shorten the head of the schedule',
    'when the median is short, lengthen the tail when it is long.',
    '',
    'options:',
    REPO_USAGE,
    DB_USAGE,
  ].join('\n'),

  async run(argv, context) {
    const {values} = parseArgsOrUsage({
      args: argv,
      options: {db: {type: 'string'}, repo: {type: 'string'}},
      allowPositionals: false,
      strict: true,
    });
    const repo = requireRepo(values.repo, 'wait stats');

    await withWaitStore(values.db, context, async (store) => {
      const all = await store.stats(repo);
      for (const entry of all) {
        await writeLine(context.stdout, statsXml(repo, entry));
      }
      await context.log.info('wait stats', {repo, kinds: all.length});
    });
  },
};

function statsXml(repo: string, entry: WaitStats): string {
  return `<wait repo="${attr(repo)}" kind="${entry.kind}" count="${String(entry.count)}" median-s="${String(entry.medianS)}"/>`;
}

function requireRepo(raw: string | undefined, where: string): string {
  assertUsage(
    raw !== undefined && raw !== '',
    `${where} needs --repo (the repository as owner/repo)`
  );
  assert(
    /^[^/\s]+\/[^/\s]+$/u.test(raw),
    new UsageError(`--repo must be owner/repo, not "${raw}"`, {
      hint: 'e.g. --repo octocat/hello-world.',
    })
  );
  return raw;
}

async function withWaitStore<T>(
  db: string | undefined,
  {env}: Pick<CommandContext, 'env'>,
  body: (store: WaitStore) => Promise<T>
): Promise<T> {
  const store = await WaitStore.open(resolveDbPath(db, env));
  try {
    return await body(store);
  } finally {
    await store.close();
  }
}

export const wait = group({
  name: 'wait',
  summary: 'Record and read per-repo wait history (CI, reviewer, merge).',
  children: [record, stats],
});
