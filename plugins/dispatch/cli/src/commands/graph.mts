import assert from 'node:assert';
import { readFile } from 'node:fs/promises';
import { text } from 'node:stream/consumers';

import { loadConfig, resolveDbPath, type GraphConfig } from '../config.mts';
import { UsageError } from '../errors.mts';
import { derive } from '../graph/derive.mts';
import { toJson, toXml } from '../graph/document.mts';
import { computeMilestoneStates } from '../graph/milestones.mts';
import { analyzeBlocking } from '../graph/blocking.mts';
import { parsePayload } from '../ingest/payload.mts';
import { logger } from '../log.mts';
import { isExclusionKind } from '../roles.mts';
import { GraphStore } from '../store/store.mts';

export interface CommandContext {
  values: Record<string, string | boolean | undefined>;
  positionals: string[];
  stdout: (chunk: string) => void;
}

/**
 * Flags shared by every graph command. `parseArgs` needs the full option table
 * up front, so it lives here rather than per subcommand.
 */
export const GRAPH_OPTIONS = {
  db: { type: 'string' },
  config: { type: 'string' },
  tracker: { type: 'string' },
  source: { type: 'string' },
  file: { type: 'string' },
  format: { type: 'string' },
  id: { type: 'string' },
  kind: { type: 'string' },
  value: { type: 'string' },
  milestone: { type: 'string' },
  full: { type: 'boolean' },
} as const;

async function withStore<T>(
  values: CommandContext['values'],
  body: (store: GraphStore, config: GraphConfig) => Promise<T>,
): Promise<T> {
  const path = resolveDbPath(asString(values.db));
  const config = await loadConfig(asString(values.config));
  const store = await GraphStore.open(path);
  try {
    return await body(store, config);
  } finally {
    await store.close();
  }
}

/**
 * Merge one fetch into the durable graph. The producer's write path: an adapter
 * fetches over MCP (or an API), normalizes, and hands the result here.
 */
export async function graphIngest(ctx: CommandContext): Promise<void> {
  const tracker = asString(ctx.values.tracker) ?? 'linear';
  const source = asString(ctx.values.source) ?? tracker;
  const full = ctx.values.full === true;

  const raw = await readPayload(asString(ctx.values.file));

  assert(
    raw.trim() !== '',
    new UsageError(
      'the ingest payload was empty',
      'pipe the payload JSON on stdin, or pass --file <path>.',
    ),
  );

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new UsageError(
      `the ingest payload is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
      'emit a single JSON object. If you built it by hand, write it to a file and pass --file so shell quoting cannot corrupt it.',
    );
  }

  await withStore(ctx.values, async (store, config) => {
    const delta = parsePayload(parsed, { tracker, config, source });
    const result = await store.applyDelta(delta, { full });

    logger.info({
      cmd: 'graph.ingest',
      tracker,
      source,
      sync: full ? 'full' : 'delta',
      nodes: result.nodesUpserted,
      deleted: result.nodesDeleted,
      edges: result.edgesWritten,
      projects: result.projects,
      milestones: result.milestones,
      cursor: delta.cursors[source] ?? null,
    });
  });
}

/** Emit the derived project-graph document — the orchestrator's read path. */
export async function graphDoc(ctx: CommandContext): Promise<void> {
  const format = asString(ctx.values.format) ?? 'xml';
  assert(
    format === 'xml' || format === 'json',
    new UsageError(
      `unknown --format "${format}"`,
      'use --format xml (default) or --format json.',
    ),
  );

  await withStore(ctx.values, async (store, config) => {
    const snapshot = await store.snapshot();
    const graph = derive(snapshot, { parkedRoles: config.parkedRoles });

    ctx.stdout(`${format === 'xml' ? toXml(graph) : toJson(graph)}\n`);

    logger.info({
      cmd: 'graph.doc',
      nodes: graph.nodes.length,
      edges: graph.edges.length,
      available: graph.available.length,
      blocked: graph.blocked.length,
      human_blocked: graph.humanBlocked.length,
      permanently_blocked: graph.permanentlyBlocked.length,
      anomalies: graph.anomalies.length,
      projects: graph.counts.length,
      // An empty graph is NOT terminal — `every` on no projects is vacuously
      // true, and reporting that would tell an orchestrator its work was
      // finished when in truth nothing has been ingested yet.
      terminal:
        graph.counts.length > 0 &&
        graph.counts.every((count) => count.terminal),
    });

    for (const anomaly of graph.anomalies) {
      logger.warn({
        cmd: 'graph.doc',
        anomaly: anomaly.kind,
        detail: anomaly.detail,
      });
    }
  });
}

/** Read or write the opaque per-source sync cursor. */
export async function graphCursor(ctx: CommandContext): Promise<void> {
  const action = ctx.positionals[2] ?? 'get';
  const source =
    asString(ctx.values.source) ?? asString(ctx.values.tracker) ?? 'linear';

  assert(
    action === 'get' || action === 'set',
    new UsageError(
      `unknown cursor action "${action}"`,
      'use: dispatch graph cursor get --source <tracker>, or ... cursor set --source <tracker> --value <token>.',
    ),
  );

  await withStore(ctx.values, async (store) => {
    if (action === 'get') {
      const value = await store.getCursor(source);
      // An absent cursor prints nothing and exits 0: the caller reads an empty
      // string and does a full sync, which is exactly the first-run path.
      if (value !== null) ctx.stdout(`${value}\n`);
      logger.info({ cmd: 'graph.cursor', action, source, value });
      return;
    }

    const value = asString(ctx.values.value);
    assert(
      value !== undefined,
      new UsageError(
        'cursor set needs a --value',
        'pass the tracker token you want stored, e.g. --value 2026-07-11T00:00:00.000Z.',
      ),
    );

    await store.setCursor(source, value);
    logger.info({ cmd: 'graph.cursor', action, source, value });
  });
}

/**
 * The orchestrator's exclusions: tickets already in flight, done, or failed.
 * They never appear in `available`, but their nodes keep updating — the cache
 * must not go stale on work that is in flight.
 */
export async function graphExclude(ctx: CommandContext): Promise<void> {
  const action = ctx.positionals[2] ?? 'list';
  assert(
    action === 'add' || action === 'remove' || action === 'list',
    new UsageError(
      `unknown exclude action "${action}"`,
      'use: dispatch graph exclude add --id <ticket> --kind <in-flight|done|failed>, ... remove --id <ticket>, or ... list.',
    ),
  );

  await withStore(ctx.values, async (store) => {
    if (action === 'list') {
      for (const exclusion of await store.listExclusions()) {
        ctx.stdout(`${exclusion.id} ${exclusion.kind}\n`);
      }
      return;
    }

    const id = asString(ctx.values.id);
    assert(
      id !== undefined,
      new UsageError(
        `exclude ${action} needs an --id`,
        'pass the ticket identifier, e.g. --id CLC-945.',
      ),
    );

    if (action === 'remove') {
      await store.removeExclusion(id);
      logger.info({ cmd: 'graph.exclude', action, id });
      return;
    }

    const kind = asString(ctx.values.kind);
    assert(
      kind !== undefined && isExclusionKind(kind),
      new UsageError(
        `exclude add needs a --kind of in-flight, done, or failed (got ${String(kind)})`,
        'in-flight = a coordinator owns it now; done = terminal; failed = it will not progress, so its dependents are permanently blocked.',
      ),
    );

    await store.addExclusion(id, kind);
    logger.info({ cmd: 'graph.exclude', action, id, kind });
  });
}

/**
 * Record that a milestone's review ran. The record is pinned to the milestone's
 * current member set, so a review filed follow-up tickets into the milestone
 * does not count as a review of the milestone those tickets now belong to.
 */
export async function graphRecordReview(ctx: CommandContext): Promise<void> {
  const milestone = asString(ctx.values.milestone);
  assert(
    milestone !== undefined,
    new UsageError(
      'record-review needs a --milestone',
      'pass the milestone id from the <milestones> section of the project-graph document.',
    ),
  );

  await withStore(ctx.values, async (store) => {
    const snapshot = await store.snapshot();
    const analysis = analyzeBlocking(snapshot.nodes, snapshot.edges);
    const states = computeMilestoneStates(
      snapshot.nodes,
      snapshot.milestones,
      snapshot.reviews,
      analysis,
    );

    const state = states.get(milestone);
    assert(
      state !== undefined,
      new UsageError(
        `no milestone "${milestone}" in the graph`,
        'use an id from the <milestones> section of the document. Ingest the milestone first if it is new.',
      ),
    );

    const recordedAt = new Date().toISOString();
    await store.recordReview(milestone, state.fingerprint, recordedAt);

    logger.info({
      cmd: 'graph.record-review',
      milestone,
      fingerprint: state.fingerprint,
      members: state.memberCount,
      recorded_at: recordedAt,
    });
  });
}

/**
 * Read the payload from `--file`, else from stdin.
 *
 * Both failure modes here are the caller's, not the CLI's, and both used to
 * present badly: an unreadable path surfaced as an internal crash (telling the
 * agent to escalate its own typo), and a missing stdin left the process waiting
 * on a pipe that would never be written — a hang with no output at all.
 */
async function readPayload(file: string | undefined): Promise<string> {
  if (file === undefined) {
    assert(
      !process.stdin.isTTY,
      new UsageError(
        'no ingest payload: nothing was piped on stdin, and no --file was given',
        'write the payload to a file and pass --file <path>, or pipe it on stdin.',
      ),
    );
    return text(process.stdin);
  }

  try {
    return await readFile(file, 'utf8');
  } catch (cause) {
    throw new UsageError(
      `cannot read the ingest payload at ${file}: ${cause instanceof Error ? cause.message : String(cause)}`,
      'check the path passed to --file. Write the payload to a file first, then pass that path.',
    );
  }
}

function asString(value: string | boolean | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
