import {classifyActionable, type ReactionGroup} from './actionability.mts';
import {cacheItem, sanitizeId} from './cache.mts';
import type {Runner} from './exec.mts';
import type {FileSystem} from './fsx.mts';
import {reactionLines, type ReactionNode} from './reactions.mts';
import {ensureSummary} from './summarize.mts';
import {attr, element, text} from './xml.mts';

interface CommentNode {
  readonly id?: string;
  readonly databaseId?: number;
  readonly body?: string;
  readonly author?: {readonly login?: string} | null;
  readonly reactions?: {readonly nodes?: readonly ReactionNode[]} | null;
  readonly reactionGroups?: readonly ReactionGroup[];
}

export interface CommentsInput {
  readonly fs: FileSystem;
  readonly run: Runner;
  readonly dir: string;
  readonly callerLogin: string;
  readonly comments: readonly unknown[];
}

/**
 * Render `<comments>` — every top-level PR comment, each classified and cached.
 * A comment's terminal reaction (read from reactionGroups' viewerHasReacted) is
 * the only signal that can settle a comment someone else authored, so reactions
 * are surfaced and fed to the classifier.
 */
export async function commentsXml(input: CommentsInput): Promise<string> {
  const {fs, run, dir, callerLogin} = input;
  const lines = ['  <comments>'];

  for (const raw of input.comments) {
    const node = raw as CommentNode;
    const rawId = node.id ?? node.databaseId?.toString() ?? '';
    if (rawId === '') continue;

    const author = node.author?.login ?? '';
    const body = node.body ?? '';
    const reactions = node.reactions?.nodes ?? [];
    const reactionGroups = node.reactionGroups ?? [];

    const id = sanitizeId(rawId);
    const {cachePath, summaryPath} = await cacheItem(
      fs,
      dir,
      'comments',
      id,
      body
    );

    const {actionable, reason} = classifyActionable({
      body,
      author,
      resolved: false,
      callerLogin,
      reactionGroups,
    });

    const summary = await ensureSummary({
      fs,
      run,
      summaryPath,
      body,
      actionable,
    });

    const childLines: string[] = [];
    if (summary !== undefined) {
      childLines.push(`      <summary>${text(summary)}</summary>`);
    }
    const reactionRows = reactionLines(reactions, '        ');
    if (reactionRows.length > 0) {
      childLines.push(
        '      <reactions>',
        ...reactionRows,
        '      </reactions>'
      );
    }

    lines.push(
      element(
        '    ',
        'comment',
        commentAttrs(id, actionable, reason, cachePath),
        childLines
      )
    );
  }

  lines.push('  </comments>');
  return lines.join('\n');
}

function commentAttrs(
  id: string,
  actionable: boolean,
  reason: string,
  cachePath: string
): string {
  const reasonAttr =
    !actionable && reason !== '' ? ` reason="${attr(reason)}"` : '';
  return `id="${attr(id)}" actionable="${String(actionable)}"${reasonAttr} cache="${attr(cachePath)}"`;
}
