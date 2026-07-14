import assert from 'node:assert';
import {readFile} from 'node:fs/promises';
import {text} from 'node:stream/consumers';

import {parseArgsOrUsage} from '../../lib/args.mts';
import type {Command} from '../../lib/command.mts';
import {DataError, describeCause, EnvironmentError} from '../../lib/errors.mts';
import {parsePayload} from '../../lib/graph/payload.mts';
import {STORE_OPTIONS, STORE_USAGE, withStore} from './store-context.mts';

/**
 * Merge one fetch into the durable graph — the producer's write path. An adapter
 * fetches over MCP (or an API), normalizes, and hands the result here.
 */
export const ingest: Command = {
  name: 'ingest',
  summary: 'Merge a fetched payload into the durable graph.',
  usage: [
    'dispatch graph ingest [--full] [--file <path>] [--tracker <name>]',
    '',
    'Reads the payload JSON on stdin unless --file is given.',
    '',
    'options:',
    '  --full           Replace the graph outright: the first-run and recovery path.',
    '  --file <path>    Read the payload from a file instead of stdin.',
    '  --tracker <name> Tracker whose default state mapping applies (default: linear).',
    '  --source <name>  Cursor namespace (default: the tracker name).',
    STORE_USAGE,
  ].join('\n'),

  async run(argv, context) {
    const {values} = parseArgsOrUsage({
      args: argv,
      options: {
        ...STORE_OPTIONS,
        tracker: {type: 'string'},
        source: {type: 'string'},
        file: {type: 'string'},
        full: {type: 'boolean'},
      },
      allowPositionals: false,
      strict: true,
    });

    const tracker = values.tracker ?? 'linear';
    const source = values.source ?? tracker;
    const full = values.full === true;

    const payload = await readPayload(values.file, context.stdin);
    assert(
      payload.trim() !== '',
      new DataError('the ingest payload was empty', {
        hint: 'pipe the payload JSON on stdin, or pass --file <path>.',
      })
    );

    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch (cause) {
      throw new DataError(
        `the ingest payload is not valid JSON: ${describeCause(cause)}`,
        {
          hint: 'emit a single JSON object. If you built it by hand, write it to a file and pass --file, so shell quoting cannot corrupt it.',
        }
      );
    }

    await withStore(values, context, async (store, config) => {
      const delta = parsePayload(parsed, {tracker, config, source});
      const result = await store.applyDelta(delta, {full});

      await context.log.info('ingested', {
        tracker,
        source,
        sync: full ? 'full' : 'delta',
        nodes: result.nodesUpserted,
        deleted: result.nodesDeleted,
        edges: result.edgesWritten,
        projects: result.projects,
        milestones: result.milestones,
        // A milestone that stopped being ready loses its review record, so its
        // next completion needs a fresh review. Worth seeing in the log: it
        // re-closes a gate the orchestrator may have been about to walk through.
        reviews_dropped: result.reviewsDropped,
        cursor: delta.cursors[source] ?? '-',
      });
    });
  },
};

async function readPayload(
  file: string | undefined,
  stdin: NodeJS.ReadableStream
): Promise<string> {
  if (file === undefined) return text(stdin);

  try {
    return await readFile(file, 'utf8');
  } catch (cause) {
    throw new EnvironmentError(
      `cannot read the ingest payload at ${file}: ${describeCause(cause)}`,
      {hint: 'check the path, or pipe the payload on stdin instead.'}
    );
  }
}
