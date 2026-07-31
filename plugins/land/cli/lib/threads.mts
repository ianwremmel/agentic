import {classifyActionable} from './actionability.mts';
import {cacheItem, sanitizeId} from './cache.mts';
import type {Runner} from './exec.mts';
import type {FileSystem} from './fsx.mts';
import {ensureSummary} from './summarize.mts';
import {attr, element, text} from './xml.mts';

interface ThreadComment {
  readonly body?: string;
  readonly author?: {readonly login?: string} | null;
}

interface ThreadNode {
  readonly id?: string;
  readonly isResolved?: boolean;
  readonly comments?: {readonly nodes?: readonly ThreadComment[]} | null;
}

export interface ThreadsInput {
  readonly fs: FileSystem;
  readonly run: Runner;
  readonly dir: string;
  readonly callerLogin: string;
  readonly threads: readonly unknown[];
}

/**
 * Render `<threads>` — each review thread cached as its full joined transcript,
 * classified on its newest comment (a reviewer reply after the agent's last turn
 * re-actionables it), and settled when the platform has resolved it.
 */
export async function threadsXml(input: ThreadsInput): Promise<string> {
  const {fs, run, dir, callerLogin} = input;
  const lines = ['  <threads>'];

  for (const raw of input.threads) {
    const node = raw as ThreadNode;
    const rawId = node.id ?? '';
    if (rawId === '') continue;

    const nodes = node.comments?.nodes ?? [];
    const body = nodes
      .map((c) => `[${c.author?.login ?? '?'}] ${c.body ?? ''}`)
      .join('\n\n---\n\n');
    const newest = nodes.at(-1);
    const newestBody = newest?.body ?? '';
    const newestAuthor = newest?.author?.login ?? '';
    const resolved = node.isResolved ?? false;

    const id = sanitizeId(rawId);
    const {cachePath, summaryPath} = await cacheItem(
      fs,
      dir,
      'threads',
      id,
      body
    );

    const {actionable, reason} = classifyActionable({
      body: newestBody,
      author: newestAuthor,
      resolved,
      callerLogin,
    });

    const summary = await ensureSummary({
      fs,
      run,
      summaryPath,
      body,
      actionable,
    });

    const childLines =
      summary === undefined
        ? []
        : [`      <summary>${text(summary)}</summary>`];

    lines.push(
      element(
        '    ',
        'thread',
        threadAttrs(id, actionable, reason, cachePath),
        childLines
      )
    );
  }

  lines.push('  </threads>');
  return lines.join('\n');
}

function threadAttrs(
  id: string,
  actionable: boolean,
  reason: string,
  cachePath: string
): string {
  const reasonAttr =
    !actionable && reason !== '' ? ` reason="${attr(reason)}"` : '';
  return `id="${attr(id)}" actionable="${String(actionable)}"${reasonAttr} cache="${attr(cachePath)}"`;
}
