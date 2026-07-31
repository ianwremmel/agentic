import {attr} from './xml.mts';

/**
 * One entry of a PR's `statusCheckRollup`. GitHub returns two shapes there — a
 * CheckRun (`name`/`conclusion`/`status`/`detailsUrl`/`startedAt`) and a
 * StatusContext (`context`/`state`/`targetUrl`) — so every field is optional and
 * read with a fallback.
 */
export interface RollupEntry {
  readonly name?: string;
  readonly context?: string;
  readonly conclusion?: string;
  readonly state?: string;
  readonly status?: string;
  readonly detailsUrl?: string;
  readonly targetUrl?: string;
  readonly startedAt?: string;
}

export interface ChecksOptions {
  /** Regex source (case-insensitive) matching non-blocking check names, or ''. */
  readonly informationalRe: string;
  /** Seconds after which an in-progress check is presumed stuck (not pending). */
  readonly stuckAfterSec: number;
  /** Current time in epoch ms, injected for deterministic tests. */
  readonly nowMs: number;
}

type RollupState = 'pending' | 'failing' | 'passing';

interface DerivedCheck {
  readonly name: string;
  readonly conclusion: string;
  readonly url: string;
  readonly informational: boolean;
  readonly pending: boolean;
  readonly failing: boolean;
  readonly stuck: boolean;
}

const FAILING_RE = /FAILURE|TIMED_OUT|CANCELLED|STARTUP_FAILURE/iu;
const PENDING_STATUSES = new Set(['IN_PROGRESS', 'QUEUED', 'PENDING']);

/**
 * Derive each check's flags and the rollup state, then render `<checks>`.
 *
 * Rollup precedence matches the protocol: any live-pending check makes the whole
 * rollup `pending`; else any blocking failure makes it `failing`; else
 * `passing`. A check that has run past `stuckAfterSec` no longer counts as
 * pending (it stops masking an otherwise-decided rollup), and an
 * `informational` check never fails the rollup.
 */
export function checksXml(
  rollup: readonly RollupEntry[],
  options: ChecksOptions
): string {
  const checks = rollup.map((entry) => derive(entry, options));

  const anyPending = checks.some((check) => check.pending && !check.stuck);
  const anyFailing = checks.some(
    (check) => check.failing && !check.informational && !check.pending
  );
  const state: RollupState = anyPending
    ? 'pending'
    : anyFailing
      ? 'failing'
      : 'passing';

  const lines = [`  <checks state="${state}">`];
  for (const check of checks) {
    lines.push(
      `    <check name="${attr(check.name)}" conclusion="${attr(check.conclusion)}" url="${attr(check.url)}" informational="${String(check.informational)}" stuck="${String(check.stuck)}"/>`
    );
  }
  lines.push('  </checks>');
  return lines.join('\n');
}

function derive(entry: RollupEntry, options: ChecksOptions): DerivedCheck {
  const name = entry.name ?? entry.context ?? 'check';
  const conclusion = entry.conclusion ?? entry.state ?? '';
  const status = entry.status ?? '';
  const url = entry.detailsUrl ?? entry.targetUrl ?? '';
  const started = entry.startedAt ?? '';

  const informational =
    options.informationalRe !== '' &&
    new RegExp(options.informationalRe, 'iu').test(name);

  const pending =
    PENDING_STATUSES.has(status) || (conclusion === '' && status !== '');
  const failing = FAILING_RE.test(conclusion);

  const startedMs = started === '' ? NaN : Date.parse(started);
  const stuck =
    status === 'IN_PROGRESS' &&
    started !== '' &&
    !Number.isNaN(startedMs) &&
    (options.nowMs - startedMs) / 1000 > options.stuckAfterSec;

  return {name, conclusion, url, informational, pending, failing, stuck};
}
