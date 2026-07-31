import {join} from 'node:path';

import {cacheItem, contentId} from './cache.mts';
import type {Runner} from './exec.mts';
import {fetchAnnotations, fetchCheckRuns} from './github.mts';
import type {FileSystem} from './fsx.mts';
import {ensureSummary} from './summarize.mts';
import {attr, element, text} from './xml.mts';

interface AnnotationRecord {
  readonly path?: string;
  readonly start_line?: number;
  readonly message?: string;
}

export interface AnnotationsInput {
  readonly fs: FileSystem;
  readonly run: Runner;
  readonly dir: string;
  readonly owner: string;
  readonly repo: string;
  /** The PR head commit sha whose check runs carry the annotations. */
  readonly sha: string;
}

/**
 * Render `<annotations>` — code-scanning / check annotations on the head commit.
 * Each is actionable until the agent acks it by dropping a `<id>.ack` file
 * (rationale recorded there or in the plan/commit); an acked annotation carries
 * its recap and drops out of the work queue.
 */
export async function annotationsXml(input: AnnotationsInput): Promise<string> {
  const {fs, run, dir, owner, repo, sha} = input;
  const lines = ['  <annotations>'];

  const runs = await fetchCheckRuns(run, owner, repo, sha);
  for (const rawRun of runs) {
    const runId = (rawRun as {id?: number | string}).id;
    if (runId === undefined) continue;

    const annotations = await fetchAnnotations(run, owner, repo, String(runId));
    for (const rawAnnotation of annotations) {
      const annotation = rawAnnotation as AnnotationRecord;
      const path = annotation.path ?? '';
      const lineNo = annotation.start_line ?? 0;
      const msg = annotation.message ?? '';
      const body = `[${path}:${String(lineNo)}] ${msg}`;
      const id = contentId(body);

      const {cachePath, summaryPath} = await cacheItem(
        fs,
        dir,
        'annotations',
        id,
        body
      );
      const ackPath = join(dir, 'annotations', `${id}.ack`);

      if (await fs.exists(ackPath)) {
        const summary = await ensureSummary({
          fs,
          run,
          summaryPath,
          body,
          actionable: false,
        });
        lines.push(
          element(
            '    ',
            'annotation',
            `id="${attr(id)}" actionable="false" reason="acked" cache="${attr(cachePath)}"`,
            summary === undefined
              ? []
              : [`      <summary>${text(summary)}</summary>`]
          )
        );
      } else {
        lines.push(
          `    <annotation id="${attr(id)}" actionable="true" cache="${attr(cachePath)}"/>`
        );
      }
    }
  }

  lines.push('  </annotations>');
  return lines.join('\n');
}
