import type {Runner} from './exec.mts';
import type {FileSystem} from './fsx.mts';

const UNAVAILABLE = '(summary unavailable)';
const PROMPT_HEAD =
  'Summarize the following PR item in 1-3 sentences describing its outcome. Plain prose only.';
/** Summaries are a recap for settled items, not on the hot path — cap the wait. */
const SUMMARIZE_TIMEOUT_MS = 120_000;

/**
 * A one-shot `claude` summary of a settled item's body, for the recap the agent
 * reads when the item later re-actionables. Degrades to a fixed placeholder
 * whenever claude is missing, errors, times out, or returns nothing — a summary
 * is an aid, never a gate, so its absence must never fail pr-status.
 */
export async function summarize(run: Runner, body: string): Promise<string> {
  try {
    const result = await run(
      'claude',
      ['-p', '--max-turns', '1', `${PROMPT_HEAD}\n\n${body}`],
      {stdin: '', timeoutMs: SUMMARIZE_TIMEOUT_MS}
    );
    const text = result.stdout.trim();
    return result.code === 0 && text !== '' ? text : UNAVAILABLE;
  } catch {
    return UNAVAILABLE;
  }
}

export interface EnsureSummaryInput {
  readonly fs: FileSystem;
  readonly run: Runner;
  readonly summaryPath: string;
  /** The item body to summarize when generating. */
  readonly body: string;
  /** Whether the item is currently actionable. */
  readonly actionable: boolean;
}

/**
 * Return the item's recap, generating it lazily first when the item is settled
 * (non-actionable) and none exists yet. A settled item's summary persists and
 * is returned in either state thereafter; an actionable item with no summary
 * yet returns undefined (nothing to recap while it is live work).
 */
export async function ensureSummary({
  fs,
  run,
  summaryPath,
  body,
  actionable,
}: EnsureSummaryInput): Promise<string | undefined> {
  if (!actionable && !(await fs.exists(summaryPath))) {
    await fs.write(summaryPath, await summarize(run, body));
  }
  if (await fs.exists(summaryPath)) {
    return (await fs.read(summaryPath)) ?? '';
  }
  return undefined;
}
