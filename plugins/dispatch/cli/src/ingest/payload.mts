import assert from 'node:assert';

import type { GraphConfig } from '../config.mts';
import { UsageError } from '../errors.mts';
import type { Milestone, Project } from '../graph/types.mts';
import { resolveRole } from '../mapping.mts';
import { isRole, isTargetKind, type Role, type TargetKind } from '../roles.mts';
import type { GraphDelta, IngestNode } from '../store/store.mts';

export interface ParseOptions {
  tracker: string;
  config: GraphConfig;
  /** Cursor namespace — usually the tracker name. */
  source: string;
}

/**
 * Parse and validate one adapter payload into a delta the store can apply.
 *
 * The payload is written by a fetching agent, so every failure names the
 * offending ticket and says what to change. Keys are accepted in camelCase or
 * snake_case: an agent hand-writing JSON should not have a fetch rejected over
 * a underscore.
 */
export function parsePayload(raw: unknown, options: ParseOptions): GraphDelta {
  const doc = asObject(raw, 'the payload');

  const nodesRaw = doc.nodes ?? [];
  assert(
    Array.isArray(nodesRaw),
    new UsageError(
      'the payload\'s "nodes" must be an array',
      'emit {"nodes": [...]} — see the build-graph skill reference for the payload shape.',
    ),
  );

  const projects = parseProjects(doc.projects);
  const milestones = parseMilestones(doc.milestones);
  const nodes = nodesRaw.map((node, index) => parseNode(node, index, options));

  return {
    projects,
    milestones,
    nodes,
    cursors: parseCursors(doc, options.source),
  };
}

function parseNode(
  raw: unknown,
  index: number,
  options: ParseOptions,
): IngestNode {
  const node = asObject(raw, `nodes[${index}]`);
  const id = requireString(node.id, `nodes[${index}].id`);
  const where = `node ${id}`;

  // These three decide whether a ticket is removed, jumps the queue, or is
  // withheld from every agent. A JSON string "true" is not a boolean, and
  // quietly reading it as `false` would turn a deletion into a resurrection.
  const deleted = requireBoolean(node.deleted, `${where}.deleted`);
  const injected = requireBoolean(node.injected, `${where}.injected`);
  const explicitHuman = requireBoolean(
    pick(node, 'humanInteractive', 'human_interactive'),
    `${where}.humanInteractive`,
  );

  if (deleted === true) {
    // A deletion only needs an id; everything else about the ticket is moot.
    return {
      id,
      project: '',
      url: '',
      title: '',
      role: 'canceled',
      milestone: null,
      targetKind: 'pr',
      humanInteractive: false,
      injected: false,
      priority: null,
      branchHint: null,
      labels: [],
      updatedAt: null,
      deleted: true,
    };
  }

  const labels = stringArray(node.labels, `${where}.labels`);
  const role = resolveNodeRole(node, where, options);

  const explicitKind = pick(node, 'targetKind', 'target_kind');
  const targetKind = resolveTargetKind(
    explicitKind,
    labels,
    where,
    options.config,
  );

  const humanInteractive =
    explicitHuman ?? hasAny(labels, options.config.humanInteractiveLabels);

  const result: IngestNode = {
    id,
    project: requireString(node.project, `${where}.project`),
    url: optionalString(node.url, `${where}.url`) ?? '',
    title: optionalString(node.title, `${where}.title`) ?? '',
    role,
    milestone: optionalString(node.milestone, `${where}.milestone`),
    targetKind,
    humanInteractive,
    injected: injected ?? false,
    priority: optionalNumber(node.priority, `${where}.priority`),
    branchHint: optionalString(
      pick(node, 'branchHint', 'branch_hint'),
      `${where}.branchHint`,
    ),
    labels,
    updatedAt: optionalString(
      pick(node, 'updatedAt', 'updated_at'),
      `${where}.updatedAt`,
    ),
  };

  // A self-edge is kept, not quietly dropped. It is an illegal dependency — a
  // cycle of length one — and the graph must surface it as an anomaly rather
  // than normalize away evidence that the tracker holds bad data.
  const blockedBy = pick(node, 'blockedBy', 'blocked_by');
  if (blockedBy !== undefined) {
    result.blockedBy = stringArray(blockedBy, `${where}.blockedBy`);
  }

  const blocks = pick(node, 'blocks');
  if (blocks !== undefined) {
    result.blocks = stringArray(blocks, `${where}.blocks`);
  }

  return result;
}

/**
 * A node may carry a resolved `role` or a native `state`. The role wins when
 * both are present — an adapter that already knows the mapping should not be
 * second-guessed.
 */
function resolveNodeRole(
  node: Record<string, unknown>,
  where: string,
  options: ParseOptions,
): Role {
  const role = optionalString(node.role, `${where}.role`);
  if (role !== null) {
    assert(
      isRole(role),
      new UsageError(
        `${where}.role is "${role}", which is not a protocol role`,
        'use one of: backlog, paused, awaiting-external, available, in-progress, in-review, finished, delivered, verified, canceled.',
      ),
    );
    return role;
  }

  const state = optionalString(node.state, `${where}.state`);
  assert(
    state !== null,
    new UsageError(
      `${where} carries neither a "role" nor a native "state"`,
      'give each node the tracker\'s native state (e.g. {"state": "In Progress"}), or a resolved protocol role.',
    ),
  );

  return resolveRole(options.tracker, state, options.config.states);
}

function resolveTargetKind(
  explicit: unknown,
  labels: string[],
  where: string,
  config: GraphConfig,
): TargetKind {
  const kind = optionalString(explicit, `${where}.targetKind`);
  if (kind !== null) {
    assert(
      isTargetKind(kind),
      new UsageError(
        `${where}.targetKind is "${kind}", which is not a target kind`,
        'use one of: pr, verification, human-only.',
      ),
    );
    return kind;
  }

  if (hasAny(labels, config.humanInteractiveLabels)) return 'human-only';
  if (hasAny(labels, config.verificationLabels)) return 'verification';
  return 'pr';
}

function parseProjects(raw: unknown): Project[] {
  if (raw === undefined || raw === null) return [];
  assert(
    Array.isArray(raw),
    new UsageError(
      'the payload\'s "projects" must be an array',
      'emit {"projects": [{"id": "...", "name": "..."}]}.',
    ),
  );

  return raw.map((entry, index) => {
    const project = asObject(entry, `projects[${index}]`);
    const id = requireString(project.id, `projects[${index}].id`);
    return {
      id,
      name: optionalString(project.name, `projects[${index}].name`) ?? id,
      declared: true,
    };
  });
}

function parseMilestones(raw: unknown): Milestone[] {
  if (raw === undefined || raw === null) return [];
  assert(
    Array.isArray(raw),
    new UsageError(
      'the payload\'s "milestones" must be an array',
      'emit {"milestones": [{"id": "...", "project": "...", "name": "...", "sortOrder": 0}]}.',
    ),
  );

  return raw.map((entry, index) => {
    const milestone = asObject(entry, `milestones[${index}]`);
    const id = requireString(milestone.id, `milestones[${index}].id`);
    const sortOrder = optionalNumber(
      pick(milestone, 'sortOrder', 'sort_order'),
      `milestones[${index}].sortOrder`,
    );

    assert(
      sortOrder !== null,
      new UsageError(
        `milestone ${id} has no sortOrder`,
        'milestone order decides which milestones gate which — fetch it from the tracker (Linear: list_milestones returns sortOrder) rather than leaving it out.',
      ),
    );

    return {
      id,
      project: requireString(milestone.project, `milestones[${index}].project`),
      name: optionalString(milestone.name, `milestones[${index}].name`) ?? id,
      sortOrder,
    };
  });
}

/**
 * The cursor is opaque to us: whatever the tracker uses to mean "changed since"
 * (Linear an `updatedAt`, GitHub a `since`). We only store and hand it back.
 */
function parseCursors(
  doc: Record<string, unknown>,
  source: string,
): Record<string, string> {
  const single = optionalString(doc.cursor, 'cursor');
  if (single !== null) return { [source]: single };

  if (doc.cursors === undefined || doc.cursors === null) return {};
  const cursors = asObject(doc.cursors, 'cursors');

  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(cursors)) {
    const text = optionalString(value, `cursors.${key}`);
    assert(
      text !== null,
      new UsageError(
        `cursors.${key} must be a string`,
        'a cursor is an opaque tracker token — pass it through unchanged.',
      ),
    );
    out[key] = text;
  }
  return out;
}

function hasAny(labels: readonly string[], wanted: readonly string[]): boolean {
  const lower = new Set(labels.map((label) => label.trim().toLowerCase()));
  return wanted.some((label) => lower.has(label.trim().toLowerCase()));
}

function pick(node: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (node[key] !== undefined) return node[key];
  }
  return undefined;
}

function asObject(raw: unknown, where: string): Record<string, unknown> {
  assert(
    typeof raw === 'object' && raw !== null && !Array.isArray(raw),
    new UsageError(
      `${where} must be a JSON object`,
      'see the build-graph skill reference for the payload shape.',
    ),
  );
  return raw as Record<string, unknown>;
}

function requireString(raw: unknown, where: string): string {
  assert(
    typeof raw === 'string' && raw.trim() !== '',
    new UsageError(
      `${where} is required and must be a non-empty string`,
      'every ticket needs its tracker identifier (e.g. "CLC-945") and its project.',
    ),
  );
  return raw.trim();
}

/**
 * A missing optional field is null. A number is accepted and stringified — some
 * trackers hand back numeric ids.
 *
 * Anything else (an object, an array, a boolean) is a malformed payload and is
 * REJECTED, not coerced. Returning null for it would be worse than the old
 * "[object Object]": `{"milestone": {"id": "m1"}}` — the shape Linear actually
 * returns — would silently drop the ticket out of its milestone, and it would
 * escape the milestone gate with nothing to show for it.
 */
function optionalString(raw: unknown, where: string): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
  assert(
    typeof raw === 'string',
    new UsageError(
      `${where} must be a string, but got ${describeType(raw)}`,
      'pass the plain value — e.g. a milestone id as "m1", not {"id": "m1"}.',
    ),
  );
  return raw.trim() === '' ? null : raw.trim();
}

/** An optional boolean. A string "true" is not a boolean, and never means one. */
function requireBoolean(raw: unknown, where: string): boolean | undefined {
  if (raw === undefined || raw === null) return undefined;
  assert(
    typeof raw === 'boolean',
    new UsageError(
      `${where} must be true or false, but got ${describeType(raw)}`,
      'emit a JSON boolean, not a string: {"deleted": true}, never {"deleted": "true"}.',
    ),
  );
  return raw;
}

function describeType(raw: unknown): string {
  if (Array.isArray(raw)) return 'an array';
  if (typeof raw === 'object') return 'an object';
  return `${typeof raw} ${JSON.stringify(raw)}`;
}

function optionalNumber(raw: unknown, where: string): number | null {
  if (raw === undefined || raw === null) return null;
  assert(
    typeof raw === 'number' && Number.isFinite(raw),
    new UsageError(
      `${where} must be a finite number`,
      'omit it entirely if the tracker does not provide one.',
    ),
  );
  return raw;
}

function stringArray(raw: unknown, where: string): string[] {
  if (raw === undefined || raw === null) return [];
  assert(
    Array.isArray(raw) && raw.every((v) => typeof v === 'string'),
    new UsageError(
      `${where} must be an array of strings`,
      'emit e.g. ["CLC-901", "CLC-902"].',
    ),
  );
  return raw.map((v) => v.trim()).filter((v) => v !== '');
}
