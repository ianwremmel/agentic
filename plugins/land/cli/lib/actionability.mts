/**
 * Whether a PR item still needs the agent's attention, and — when it doesn't —
 * a stable token saying why it was suppressed. The reason is surfaced as a
 * `reason=` attribute so the agent never has to re-derive suppression from the
 * human-facing `<summary>` prose (which describes the item's content and reads
 * as if an addressed point still stands).
 *
 * Full rules live in the deliver skill's reference.md → Actionability. In brief,
 * an item is non-actionable iff any of:
 *   - the thread is platform-resolved (`resolved`);
 *   - it is the calling agent's plan or engagement comment — a line-anchored
 *     `agent-plan`/`agent-engagement` sentinel plus author identity, so a human
 *     quoting the marker stays actionable (`agent-artifact`);
 *   - it is the calling agent's terminal-tagged reply — any `agent-reply` marker
 *     plus author identity plus a terminal signal on the last non-empty line
 *     (`agent-terminal-reply`);
 *   - the calling agent reacted to it with a terminal reaction, +1/-1/rocket
 *     (`agent-terminal-reply`).
 */

/** A terminal signal token, as the last non-empty line of a body. */
const TERMINAL_RE =
  /^\s*(?:✓|✅|done\.?|declined\.?|shipped\.?|acknowledged\.?|wontfix\.?|dismissed\.?|resolved\.?)\s*$/iu;

/** The calling agent's own plan/engagement artifact marker, on its own line. */
const ARTIFACT_MARKER_RE = /^<!-- agent-(?:plan|engagement):[^ ]+ -->$/mu;

/** The GraphQL reaction contents that count as a terminal reaction. */
const TERMINAL_REACTIONS = new Set(['THUMBS_UP', 'THUMBS_DOWN', 'ROCKET']);

export interface ReactionGroup {
  readonly content?: string;
  readonly viewerHasReacted?: boolean;
}

export interface Classification {
  readonly actionable: boolean;
  /** Empty when actionable; else the suppression token. */
  readonly reason: string;
}

export interface ClassifyInput {
  readonly body: string;
  readonly author: string;
  readonly resolved: boolean;
  /** The gh-authenticated login — the only identity the classifier trusts. */
  readonly callerLogin: string;
  readonly reactionGroups?: readonly ReactionGroup[];
}

/** True iff the body's last non-empty line is a canonical terminal signal. */
export function hasTerminalSignal(body: string): boolean {
  const last = body
    .split(/\r?\n/u)
    .filter((line) => line.trim() !== '')
    .at(-1);
  return last !== undefined && TERMINAL_RE.test(last);
}

export function classifyActionable(input: ClassifyInput): Classification {
  const {body, author, resolved, callerLogin, reactionGroups = []} = input;

  if (resolved) return {actionable: false, reason: 'resolved'};

  const isCaller = author === callerLogin;

  if (isCaller && ARTIFACT_MARKER_RE.test(body)) {
    return {actionable: false, reason: 'agent-artifact'};
  }

  if (
    isCaller &&
    hasTerminalSignal(body) &&
    body.includes('<!-- agent-reply:')
  ) {
    return {actionable: false, reason: 'agent-terminal-reply'};
  }

  const reactedTerminal = reactionGroups.some(
    (group) =>
      group.viewerHasReacted === true &&
      group.content !== undefined &&
      TERMINAL_REACTIONS.has(group.content)
  );
  if (reactedTerminal) {
    return {actionable: false, reason: 'agent-terminal-reply'};
  }

  return {actionable: true, reason: ''};
}
