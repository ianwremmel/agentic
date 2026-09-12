import type {Row} from '../db/database.mts';
import {isOutcome, isStatus, isTargetKind} from '../model/status.mts';
import type {
  Classification,
  ClassifiedItem,
  ClaimView,
  OutcomeView,
} from './types.mts';

/** SQLite hands values back loosely typed; these narrow without trusting a cast. */
export function text(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint')
    return String(value);
  return null;
}

export function integer(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  return 0;
}

export function splitList(value: unknown): string[] {
  const joined = text(value);
  return joined === null || joined === '' ? [] : joined.split(',');
}

export function toClaim(row: Row): ClaimView | null {
  const session = text(row.claim_session);
  if (session === null) return null;
  return {
    session,
    live: integer(row.claim_live) === 1,
    actor: text(row.claim_actor),
    worktree: text(row.claim_worktree),
    branch: text(row.claim_branch),
    claimedAt: text(row.claim_claimed_at) ?? '',
  };
}

export function toOutcome(row: Row): OutcomeView | null {
  const outcome = text(row.outcome);
  if (outcome === null || !isOutcome(outcome)) return null;
  return {
    outcome,
    retryable:
      row.outcome_retryable === null || row.outcome_retryable === undefined
        ? null
        : integer(row.outcome_retryable) === 1,
    detail: text(row.outcome_detail),
  };
}

export function toClassified(row: Row): ClassifiedItem {
  const status = text(row.status);
  const targetKind = text(row.target_kind);
  const rawLabels: unknown = JSON.parse(text(row.labels) ?? '[]');
  const blockedBy = splitList(row.blocked_by);
  const gatedBy = splitList(row.gated_by);

  return {
    item: {
      id: text(row.id) ?? '',
      kind: text(row.kind) === 'pr' ? 'pr' : 'ticket',
      ticket: text(row.ticket),
      project: text(row.project),
      url: text(row.url),
      title: text(row.title) ?? '',
      // The CHECK constraints validated these on the way in; the guards keep
      // the types honest without trusting a cast.
      status: status !== null && isStatus(status) ? status : null,
      repo: text(row.repo),
      prNumber:
        row.pr_number === null || row.pr_number === undefined
          ? null
          : integer(row.pr_number),
      targetKind:
        targetKind !== null && isTargetKind(targetKind) ? targetKind : null,
      requiresHuman: integer(row.requires_human) === 1,
      injected: integer(row.injected) === 1,
      priority: typeof row.priority === 'number' ? row.priority : null,
      branchHint: text(row.branch_hint),
      labels: Array.isArray(rawLabels)
        ? rawLabels.filter(
            (label): label is string => typeof label === 'string'
          )
        : [],
      milestones: splitList(row.milestones),
    },
    classification: (text(row.classification) ?? 'dormant') as Classification,
    effectiveBlocked: blockedBy.length > 0 || gatedBy.length > 0,
    blockedBy,
    gatedBy,
    claim: toClaim(row),
    outcome: toOutcome(row),
    fanout: integer(row.fanout),
  };
}
