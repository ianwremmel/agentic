import assert from 'node:assert';

import {DataError} from '../errors.mts';
import type {GraphConfig} from './config.mts';
import {resolveRole} from './mapping.mts';
import type {TargetKind} from './roles.mts';
import type {GraphNode} from './types.mts';

/** Raw `task set` flags, as `parseArgs` hands them over. */
export interface TaskInput {
  id: string | undefined;
  project: string | undefined;
  state: string | undefined;
  milestone: string | undefined;
  priority: string | undefined;
  url: string | undefined;
  title: string | undefined;
  labels: string | undefined;
  branchHint: string | undefined;
  updatedAt: string | undefined;
  injected: boolean;
}

/**
 * Resolve one `task set` invocation into a task the store can hold.
 *
 * The agent passes only what the tracker gave it — a native `state` and `labels`.
 * The role, target-kind, and human-interactive flag are *derived* here (role from
 * the state mapping, the other two from labels + config), so the caller never has
 * to understand the protocol vocabulary.
 */
export function resolveTask(
  input: TaskInput,
  options: {tracker: string; config: GraphConfig}
): GraphNode {
  const id = required(input.id, 'id');
  const project = required(input.project, 'project');
  const state = required(input.state, 'state');
  const labels = splitLabels(input.labels);

  return {
    id,
    project,
    url: input.url ?? '',
    title: input.title ?? '',
    role: resolveRole(options.tracker, state, options.config.states),
    milestone: blankToNull(input.milestone),
    targetKind: targetKind(labels, options.config),
    humanInteractive: hasAny(labels, options.config.humanInteractiveLabels),
    injected: input.injected,
    priority: parsePriority(input.priority),
    branchHint: blankToNull(input.branchHint),
    labels,
    updatedAt: blankToNull(input.updatedAt),
  };
}

function targetKind(
  labels: readonly string[],
  config: GraphConfig
): TargetKind {
  if (hasAny(labels, config.humanInteractiveLabels)) return 'human-only';
  if (hasAny(labels, config.verificationLabels)) return 'verification';
  return 'pr';
}

function required(value: string | undefined, flag: string): string {
  assert(
    value !== undefined && value.trim() !== '',
    new DataError(`task set needs --${flag}`, {
      hint: `every task needs --id, --project, and --state; got no --${flag}.`,
    })
  );
  return value.trim();
}

function blankToNull(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function splitLabels(value: string | undefined): string[] {
  if (value === undefined) return [];
  return value
    .split(',')
    .map((label) => label.trim())
    .filter((label) => label !== '');
}

function parsePriority(value: string | undefined): number | null {
  if (value === undefined || value.trim() === '') return null;
  const priority = Number(value);
  assert(
    Number.isFinite(priority),
    new DataError(`--priority must be a number, got "${value}"`, {
      hint: 'omit --priority entirely if the tracker has none.',
    })
  );
  return priority;
}

function hasAny(labels: readonly string[], wanted: readonly string[]): boolean {
  const lower = new Set(labels.map((label) => label.toLowerCase()));
  return wanted.some((label) => lower.has(label.trim().toLowerCase()));
}
