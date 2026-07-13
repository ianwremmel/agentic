#!/usr/bin/env node
/**
 * dispatch — the shared CLI behind the dispatch skills.
 *
 * Skills fetch from trackers and forges themselves (over MCP, `gh`, or an API);
 * this CLI is where that data lands and where anything that must be computed
 * the same way every time — dependency blocking, ranking, cycle detection —
 * actually happens. Local state lives in SQLite.
 *
 * Invoke it through `scripts/dispatch`, which checks the Node runtime first.
 *
 * Usage:
 *   dispatch graph ingest [--full] [--tracker <t>] [--source <s>] [--file <p>]
 *   dispatch graph doc [--format xml|json]
 *   dispatch graph cursor get|set [--source <s>] [--value <token>]
 *   dispatch graph exclude add|remove|list [--id <ticket>] [--kind <k>]
 *   dispatch graph record-review --milestone <id>
 *
 * Common flags: --db <path>, --config <path>, --quiet, --verbose, --help
 *
 * Exit codes: 0 ok · 2 bad invocation · 3 bad environment · 4 data needs config
 */
import { parseArgs } from 'node:util';

import {
  GRAPH_OPTIONS,
  graphCursor,
  graphDoc,
  graphExclude,
  graphIngest,
  graphRecordReview,
  type CommandContext,
} from './src/commands/graph.mts';
import { EXIT, UsageError, formatError } from './src/errors.mts';
import { setLogLevel } from './src/log.mts';

type Handler = (ctx: CommandContext) => Promise<void>;

/**
 * The command table. A new namespace (slots, locks, …) is a new entry here and
 * a new module under src/commands — the routing below does not change.
 */
const COMMANDS: Record<string, Record<string, Handler>> = {
  graph: {
    ingest: graphIngest,
    doc: graphDoc,
    cursor: graphCursor,
    exclude: graphExclude,
    'record-review': graphRecordReview,
  },
};

const USAGE = `dispatch — shared CLI for the dispatch skills

  dispatch graph ingest [--full] [--tracker <t>] [--source <s>] [--file <path>]
      Merge one fetch into the durable graph. Payload JSON on stdin, or --file.
      --full replaces the graph outright (first run, or recovery).

  dispatch graph doc [--format xml|json]
      Emit the derived project-graph document on stdout.

  dispatch graph cursor get|set [--source <s>] [--value <token>]
      Read or write the opaque per-tracker sync cursor. An absent cursor prints
      nothing — that is the signal to do a full sync.

  dispatch graph exclude add|remove|list [--id <ticket>] [--kind in-flight|done|failed]
      Tickets the orchestrator already owns. Excluded tickets never rank into
      the available frontier; a failed one permanently blocks its dependents.

  dispatch graph record-review --milestone <id>
      Record that a milestone's review ran, against its current member set.

Common flags:
  --db <path>       graph database (default: $DISPATCH_GRAPH_DB, else the XDG cache)
  --config <path>   team state mappings and label config
  --quiet           errors only        --verbose   include debug logs
  --help            this text
`;

async function main(argv: string[]): Promise<number> {
  let values: Record<string, string | boolean | undefined>;
  let positionals: string[];

  try {
    ({ values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        ...GRAPH_OPTIONS,
        help: { type: 'boolean', short: 'h' },
        quiet: { type: 'boolean' },
        verbose: { type: 'boolean' },
      },
    }));
  } catch (cause) {
    // parseArgs rejects unknown flags and missing flag values. That is the
    // caller's mistake, not a crash, so it exits as usage rather than as a bug.
    throw new UsageError(
      cause instanceof Error ? cause.message : String(cause),
      'run `dispatch --help` for the flags each command accepts.',
    );
  }

  if (values.help === true || positionals.length === 0) {
    process.stdout.write(USAGE);
    return EXIT.ok;
  }

  if (values.quiet === true) setLogLevel('error');
  if (values.verbose === true) setLogLevel('debug');

  const [namespace, command] = positionals;

  const group = namespace === undefined ? undefined : COMMANDS[namespace];
  if (group === undefined) {
    throw new UsageError(
      `unknown command group "${String(namespace)}"`,
      `known groups: ${Object.keys(COMMANDS).join(', ')}. Run \`dispatch --help\`.`,
    );
  }

  const handler = command === undefined ? undefined : group[command];
  if (handler === undefined) {
    throw new UsageError(
      `unknown command "${String(namespace)} ${String(command)}"`,
      `known ${String(namespace)} commands: ${Object.keys(group).join(', ')}. Run \`dispatch --help\`.`,
    );
  }

  await handler({
    values,
    positionals,
    stdout: (chunk) => process.stdout.write(chunk),
  });

  return EXIT.ok;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  const { text, code } = formatError(error);
  process.stderr.write(`${text}\n`);
  process.exitCode = code;
}
