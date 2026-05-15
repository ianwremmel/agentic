// §2.2.2 — PR Status Protocol: XML emitter.
//
// Pure renderer: given an already-fetched, already-classified snapshot of
// a PR, produce the `<pr-status>` document on stdout per §XML output.
// Platform adapters (#34, #38) supply the snapshot; this module never
// touches the network.

export interface PrStatusInput {
  pr: PrMeta;
  checks: readonly CheckInput[];
  reviews: readonly ReviewInput[];
  comments: readonly CommentInput[];
  threads: readonly ThreadInput[];
  annotations: readonly AnnotationInput[];
  /**
   * Annotation IDs whose `.ack` marker file exists in the cache. Per
   * §Actionability rules §Annotations, an annotation is non-actionable
   * iff it appears in this set.
   */
  ackedAnnotationIds: ReadonlySet<string>;
  /** The calling agent's identity. Required by §Calling agent identity. */
  agentId: string;
}

export interface PrMeta {
  /** `<owner>/<repo>` form. */
  repo: string;
  /** Pull request number (positive integer). */
  number: number;
  /** Current head branch name or commit SHA. */
  head: string;
  /** Whether the PR cannot merge due to conflicts. */
  mergeConflicts: boolean;
}

export interface CheckInput {
  name: string;
  /** Platform conclusion value, emitted unmodified. */
  conclusion: string;
  url: string;
  /** Default false. Informational failures do not contribute to `failing`. */
  informational?: boolean;
  /** Default false. Stuck checks do not contribute to `pending`. */
  stuck?: boolean;
  /**
   * Whether the platform reports this check as currently in progress.
   * Not emitted in the XML; used only for rollup.
   */
  inProgress?: boolean;
  /**
   * Whether the platform conclusion counts as a failure (e.g. GitHub
   * "failure" / "cancelled" / "timed_out"). The platform adapter
   * normalizes this; the emitter is platform-agnostic.
   */
  failed?: boolean;
}

export type ReviewState =
  | "commented"
  | "approved"
  | "changes_requested"
  | "dismissed";

export interface ReviewInput {
  author: string;
  /** Already classified per §Mode classification ("bot" or "human"). */
  mode: "bot" | "human";
  state: ReviewState;
}

export interface CommentInput {
  id: string;
  /** Absolute path to `comments/<id>.md`. */
  cachePath: string;
  /**
   * Agent id of the newest comment's author, if it was an agent post.
   * Used to detect "newest comment was by this agent".
   */
  lastAuthorAgentId?: string;
  /** Whether the newest comment carried a terminal signal (§Terminal signals). */
  lastSignalTerminal?: boolean;
  /** 1–3 sentence summary; required when the comment is non-actionable. */
  summary?: string;
}

export interface ThreadInput {
  id: string;
  cachePath: string;
  /** Platform-resolved (e.g. GitHub "Resolved" on a review thread). */
  resolved?: boolean;
  lastAuthorAgentId?: string;
  lastSignalTerminal?: boolean;
  summary?: string;
}

export interface AnnotationInput {
  id: string;
  cachePath: string;
  summary?: string;
}

/**
 * Render the snapshot to `<pr-status>` XML per §XML output. The result is
 * plain UTF-8 (no BOM) and is byte-stable for identical inputs.
 */
export function emitPrStatusXml(input: PrStatusInput): string {
  if (!input.agentId) {
    // §Calling agent identity: the script MUST NOT fall back to a default
    // identity; it MUST fail with an error.
    throw new Error("emitPrStatusXml: agentId is required");
  }
  if (!Number.isInteger(input.pr.number) || input.pr.number <= 0) {
    throw new Error(
      `emitPrStatusXml: pr.number must be a positive integer (got ${String(input.pr.number)})`,
    );
  }

  const lines: string[] = [];
  lines.push(
    `<pr-status repo=${attr(input.pr.repo)} pr=${attr(String(input.pr.number))} head=${attr(input.pr.head)}>`,
  );
  lines.push(...renderChecks(input.checks));
  lines.push(
    `  <merge-conflicts present=${attr(String(input.pr.mergeConflicts))}/>`,
  );
  lines.push(...renderReviews(input.reviews));
  lines.push(
    ...renderItems(
      "comments",
      "comment",
      input.comments.map((c) => ({
        id: c.id,
        cachePath: c.cachePath,
        actionable: isCommentActionable(c, input.agentId),
        summary: c.summary,
      })),
    ),
  );
  lines.push(
    ...renderItems(
      "threads",
      "thread",
      input.threads.map((t) => ({
        id: t.id,
        cachePath: t.cachePath,
        actionable: isThreadActionable(t, input.agentId),
        summary: t.summary,
      })),
    ),
  );
  lines.push(
    ...renderItems(
      "annotations",
      "annotation",
      input.annotations.map((a) => ({
        id: a.id,
        cachePath: a.cachePath,
        actionable: !input.ackedAnnotationIds.has(a.id),
        summary: a.summary,
      })),
    ),
  );
  lines.push("</pr-status>");
  return lines.join("\n") + "\n";
}

function renderChecks(checks: readonly CheckInput[]): string[] {
  const state = rollupChecks(checks);
  const out: string[] = [`  <checks state=${attr(state)}>`];
  for (const c of checks) {
    const attrs = [
      `name=${attr(c.name)}`,
      `conclusion=${attr(c.conclusion)}`,
      `url=${attr(c.url)}`,
    ];
    if (c.informational === true) attrs.push(`informational=${attr("true")}`);
    if (c.stuck === true) attrs.push(`stuck=${attr("true")}`);
    out.push(`    <check ${attrs.join(" ")}/>`);
  }
  out.push("  </checks>");
  return out;
}

export function rollupChecks(
  checks: readonly CheckInput[],
): "passing" | "failing" | "pending" {
  const liveInProgress = checks.some(
    (c) => c.inProgress === true && c.stuck !== true,
  );
  if (liveInProgress) return "pending";

  const counted = checks.some(
    (c) =>
      c.failed === true &&
      c.informational !== true &&
      !(c.inProgress === true && c.stuck !== true),
  );
  if (counted) return "failing";

  return "passing";
}

function renderReviews(reviews: readonly ReviewInput[]): string[] {
  const out: string[] = ["  <reviews>"];
  for (const r of reviews) {
    out.push(
      `    <review author=${attr(r.author)} mode=${attr(r.mode)} state=${attr(r.state)}/>`,
    );
  }
  out.push("  </reviews>");
  return out;
}

interface RenderItem {
  id: string;
  cachePath: string;
  actionable: boolean;
  summary?: string;
}

function renderItems(
  groupTag: string,
  itemTag: string,
  items: readonly RenderItem[],
): string[] {
  const out: string[] = [`  <${groupTag}>`];
  for (const item of items) {
    const head = `    <${itemTag} id=${attr(item.id)} actionable=${attr(String(item.actionable))} cache=${attr(item.cachePath)}`;
    if (item.actionable) {
      out.push(`${head}/>`);
    } else {
      const summary = item.summary?.trim();
      if (!summary) {
        throw new Error(
          `emitPrStatusXml: non-actionable ${itemTag} ${item.id} requires a non-empty summary`,
        );
      }
      out.push(`${head}>`);
      out.push(`      <summary>${escapeText(summary)}</summary>`);
      out.push(`    </${itemTag}>`);
    }
  }
  out.push(`  </${groupTag}>`);
  return out;
}

function isCommentActionable(c: CommentInput, agentId: string): boolean {
  if (c.lastAuthorAgentId === agentId && c.lastSignalTerminal === true) {
    return false;
  }
  return true;
}

function isThreadActionable(t: ThreadInput, agentId: string): boolean {
  if (t.resolved === true) return false;
  if (t.lastAuthorAgentId === agentId && t.lastSignalTerminal === true) {
    return false;
  }
  return true;
}

function attr(value: string): string {
  return `"${escapeAttr(value)}"`;
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
