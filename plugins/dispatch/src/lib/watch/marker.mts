/**
 * The agent id this plugin writes into its machine markers. The wire format
 * is `<!-- agent-reply:<agent-id> -->` on a post's first line.
 */
export const AGENT_ID = 'dispatch';

const MARKER = new RegExp(`^\\s*<!--\\s*agent-reply:${AGENT_ID}\\s*-->`, 'iu');

/**
 * Whether this agent wrote a post, judged by its own marker rather than by
 * the authoring account.
 *
 * The account is the wrong test. Under shared credentials the agent posts as
 * the operator, so filtering by login would suppress the operator's own
 * review — the one signal a waiting worker most needs. The marker is written
 * by this agent and by nothing else, so it identifies authorship regardless
 * of which account carried it.
 *
 * Matching the agent id specifically, not a bare `agent-reply`, keeps another
 * tool's marked post actionable.
 */
export function writtenByThisAgent(body: string | null | undefined): boolean {
  return typeof body === 'string' && MARKER.test(body);
}
