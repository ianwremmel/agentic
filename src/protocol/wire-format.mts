// §2.1.2 — Agent Communication Protocol: wire format helpers.
//
// Implements the write-side of the communication protocol: prepending the
// machine marker on every agent-authored post and applying the Mode B
// sparkle wrapper around the body when the writer's identity is
// human-credentialed.

const MARKER_PREFIX = "<!-- agent-reply";
const MARKER_SUFFIX = " -->";
const SPARKLE = "\u2728";

const AGENT_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

const MARKER_LINE_PATTERN = /^<!-- agent-reply(?::([A-Za-z0-9._-]+))? -->$/;

export type Mode = "A" | "B";

export interface WrapCommentInput {
  /**
   * The agent's stable identity (carried inside the marker as
   * `agent-reply:<id>`). May be omitted to emit a bare `<!-- agent-reply -->`
   * marker, which is accepted for backwards compatibility.
   */
  agentId?: string;
  mode: Mode;
  body: string;
}

export interface ParsedMarker {
  /**
   * The agent id from the marker, or `undefined` if the marker was the
   * bare form (`<!-- agent-reply -->`).
   */
  agentId: string | undefined;
  /** Detected mode: B iff the body is wrapped in a sparkle block. */
  mode: Mode;
  /** The body with the marker (and Mode B sparkle wrapper) stripped. */
  body: string;
}

/**
 * Format an agent-authored post per §2.1.2 §Wire format.
 *
 * - Machine marker is the first line, alone, no leading whitespace.
 * - Mode B additionally wraps the body in a sparkle block: a `✨` line, one
 *   blank line, the body, one blank line, another `✨` line.
 * - Mode A emits just `<marker>\n<body>`.
 *
 * The agent id, if present, MUST satisfy the marker's ABNF
 * (`ALPHA / DIGIT / "-" / "_" / "."`). The function throws if it does not.
 */
export function wrapComment({ agentId, mode, body }: WrapCommentInput): string {
  const marker = formatMarker(agentId);
  if (mode === "A") {
    return `${marker}\n${body}`;
  }
  return `${marker}\n${SPARKLE}\n\n${body}\n\n${SPARKLE}`;
}

/**
 * Format the reaction body for a reaction-only operation per §Writing rules.
 * Reactions carry no body and require neither the machine marker nor the
 * sparkle wrapper, so this helper returns the input unchanged. It exists as
 * a typed seam so callers route reactions through a different code path
 * than text posts and cannot accidentally apply the wrapper.
 */
export function wrapReaction(reaction: string): string {
  return reaction;
}

/**
 * Parse a post produced by `wrapComment` (or any spec-conformant agent
 * post) and recover the agent id, detected mode, and original body.
 *
 * Returns `undefined` when no machine marker is present as the first line —
 * i.e. the post is not agent-authored under this protocol.
 */
export function parseMarker(post: string): ParsedMarker | undefined {
  const newlineIdx = post.indexOf("\n");
  const firstLine = newlineIdx === -1 ? post : post.slice(0, newlineIdx);
  const match = MARKER_LINE_PATTERN.exec(firstLine);
  if (!match) {
    return undefined;
  }
  const agentId = match[1];
  const rest = newlineIdx === -1 ? "" : post.slice(newlineIdx + 1);

  const lines = rest.split("\n");
  if (
    lines.length >= 4 &&
    lines[0] === SPARKLE &&
    lines[1] === "" &&
    lines[lines.length - 1] === SPARKLE &&
    lines[lines.length - 2] === ""
  ) {
    const body = lines.slice(2, lines.length - 2).join("\n");
    return { agentId, mode: "B", body };
  }
  return { agentId, mode: "A", body: rest };
}

function formatMarker(agentId: string | undefined): string {
  if (agentId === undefined) {
    return `${MARKER_PREFIX}${MARKER_SUFFIX}`;
  }
  if (!AGENT_ID_PATTERN.test(agentId)) {
    throw new Error(
      `invalid agent id: ${JSON.stringify(agentId)} (must match [A-Za-z0-9._-]+)`,
    );
  }
  return `${MARKER_PREFIX}:${agentId}${MARKER_SUFFIX}`;
}
