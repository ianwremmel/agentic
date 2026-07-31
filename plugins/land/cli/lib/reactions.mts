import {attr} from './xml.mts';

/** GraphQL ReactionContent → the platform-normalized emoji name. */
export function reactionEmoji(content: string): string {
  switch (content) {
    case 'THUMBS_UP':
      return '+1';
    case 'THUMBS_DOWN':
      return '-1';
    case 'LAUGH':
      return 'laugh';
    case 'HOORAY':
      return 'hooray';
    case 'CONFUSED':
      return 'confused';
    case 'HEART':
      return 'heart';
    case 'ROCKET':
      return 'rocket';
    case 'EYES':
      return 'eyes';
    default:
      return content.toLowerCase();
  }
}

export interface ReactionNode {
  readonly content?: string;
  readonly user?: {readonly login?: string} | null;
}

/**
 * Render `<reaction>` lines for a comment's reactions, indented under a
 * `<reactions>` wrapper the caller opens. Returns [] when there are none, so the
 * caller can decide whether the comment has any inner content at all.
 */
export function reactionLines(
  reactions: readonly ReactionNode[],
  indent: string
): string[] {
  const lines: string[] = [];
  for (const reaction of reactions) {
    const user = reaction.user?.login ?? '';
    const content = reaction.content ?? '';
    if (user === '' || content === '') continue;
    lines.push(
      `${indent}<reaction author="${attr(user)}" emoji="${attr(reactionEmoji(content))}"/>`
    );
  }
  return lines;
}
