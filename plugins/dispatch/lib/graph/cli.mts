/**
 * `project-graph` — merge an adapter's delta into the cache, then emit the
 * derived document.
 *
 *   project-graph refresh --run-dir <dir> --delta <delta.xml>
 *   project-graph derive  --run-dir <dir>
 *
 * `refresh` is the tick's whole graph step. The cursor and the exclusions live in
 * the run directory, so the caller passes neither: a stateless tick cannot be
 * asked to remember them.
 */

import {existsSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

import {derive} from './derive.mts';
import {readDelta} from './delta.mts';
import {EMPTY, merge} from './merge.mts';
import {writeDocument} from './document.mts';
import {excludedKeys, injectedKeys, open} from '../state/db.mts';
import type {Graph} from './types.mts';

/** Where the run keeps its state. Mirrors `dispatch-state`'s layout. */
interface RunPaths {
  graph: string;
  document: string;
}

const paths = (runDir: string): RunPaths => ({
  graph: join(runDir, 'graph.json'),
  document: join(runDir, 'document.xml'),
});

/** Write via a unique temp file, so a crash mid-write cannot leave a torn cache. */
function writeAtomic(path: string, contents: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, contents);
  renameSync(tmp, path);
}

/**
 * The active set is `dispatch-state`'s. Read it rather than making the caller pass
 * exclusions in: every unit it knows about is work that must stay off the
 * frontier, and an injected id must keep its rank across ticks.
 */
function scheduling(runDir: string): {exclude: string[]; priority: string[]} {
  const db = open(runDir);
  try {
    return {exclude: excludedKeys(db), priority: injectedKeys(db)};
  } finally {
    db.close();
  }
}

const loadGraph = (path: string): Graph =>
  existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Graph) : structuredClone(EMPTY);

function emit(runDir: string): string {
  const p = paths(runDir);
  const document = derive(loadGraph(p.graph), scheduling(runDir));
  writeAtomic(p.document, writeDocument(document));
  return p.document;
}

export function main(argv: string[]): void {
  const command = argv[0];
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    if (i === -1) return undefined;
    const value = argv[i + 1];
    // A missing value that swallows the next flag is how a typo becomes a wrong
    // graph. Refuse it.
    if (value === undefined || value.startsWith('--')) throw new Error(`--${name} needs a value`);
    return value;
  };

  const runDir = flag('run-dir');
  if (!runDir) throw new Error('--run-dir is required');

  if (command === 'refresh') {
    const deltaPath = flag('delta');
    if (!deltaPath) throw new Error('--delta is required');
    const p = paths(runDir);
    const merged = merge(loadGraph(p.graph), readDelta(readFileSync(deltaPath, 'utf8')));
    writeAtomic(p.graph, `${JSON.stringify(merged, null, 2)}\n`);
    console.log(emit(runDir));
    return;
  }

  if (command === 'derive') {
    console.log(emit(runDir));
    return;
  }

  throw new Error('usage: project-graph {refresh|derive} --run-dir <dir> [--delta <delta.xml>]');
}
