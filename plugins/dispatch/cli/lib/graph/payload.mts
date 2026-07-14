import assert from 'node:assert';

import {DataError} from '../errors.mts';
import type {GraphConfig} from './config.mts';
import {resolveRole} from './mapping.mts';
import {
  isRole,
  isTargetKind,
  ROLE_LIST,
  TARGET_KIND_LIST,
  type Role,
  type TargetKind,
} from './roles.mts';
import type {GraphDelta, IngestNode} from './store.mts';
import type {Milestone, Project} from './types.mts';

export interface ParseOptions {
  tracker: string;
  config: GraphConfig;
  /** Cursor namespace — usually the tracker name. */
  source: string;
}

/**
 * Parse and validate one adapter payload into a delta the store can apply.
 *
 * A fetching agent writes this payload, so every failure names the offending
 * ticket and says what to change: the agent has to be able to fix its own output
 * without a human reading the schema for it. Keys are accepted in camelCase or
 * snake_case — an agent hand-writing JSON should not lose a fetch to an
 * underscore.
 */
export function parsePayload(raw: unknown, options: ParseOptions): GraphDelta {
  const doc = asObject(raw, 'the payload');

  const rawNodes = doc.nodes ?? [];
  assert(
    Array.isArray(rawNodes),
    new DataError('the payload\'s "nodes" must be an array', {
      hint: 'emit {"nodes": [...]} — see the build-graph skill reference for the payload shape.',
    })
  );

  return {
    projects: parseProjects(doc.projects),
    milestones: parseMilestones(doc.milestones),
    nodes: rawNodes.map((node, index) => parseNode(node, index, options)),
    cursors: parseCursors(doc, options.source),
  };
}

function parseNode(
  raw: unknown,
  index: number,
  options: ParseOptions
): IngestNode {
  const node = asObject(raw, `nodes[${String(index)}]`);
  const id = requireString(node.id, `nodes[${String(index)}].id`);
  const where = `node ${id}`;

  // These three decide whether a ticket is removed, jumps the queue, or is
  // withheld from every agent. A JSON string "true" is not a boolean, and
  // quietly reading it as `false` would turn a deletion into a resurrection.
  const deleted = optionalBoolean(node.deleted, `${where}.deleted`);
  const injected = optionalBoolean(node.injected, `${where}.injected`);
  const explicitHuman = optionalBoolean(
    pick(node, 'humanInteractive', 'human_interactive'),
    `${where}.humanInteractive`
  );

  if (deleted === true) {
    // A deletion needs only an id; everything else about the ticket is moot.
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

  const result: IngestNode = {
    id,
    project: requireString(node.project, `${where}.project`),
    url: optionalString(node.url, `${where}.url`) ?? '',
    title: optionalString(node.title, `${where}.title`) ?? '',
    role: resolveNodeRole(node, where, options),
    milestone: optionalString(node.milestone, `${where}.milestone`),
    targetKind: resolveTargetKind(
      pick(node, 'targetKind', 'target_kind'),
      labels,
      where,
      options.config
    ),
    humanInteractive:
      explicitHuman ?? hasAny(labels, options.config.humanInteractiveLabels),
    injected: injected ?? false,
    priority: optionalNumber(node.priority, `${where}.priority`),
    branchHint: optionalString(
      pick(node, 'branchHint', 'branch_hint'),
      `${where}.branchHint`
    ),
    labels,
    updatedAt: optionalString(
      pick(node, 'updatedAt', 'updated_at'),
      `${where}.updatedAt`
    ),
  };

  // A self-edge is kept, not quietly dropped. It is an illegal dependency — a
  // cycle of length one — and the graph must surface it as an anomaly rather
  // than normalize away the evidence that the tracker holds bad data.
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
 * A node may carry a resolved `role` or the tracker's native `state`. The role
 * wins when both are there: an adapter that already knows the mapping should not
 * be second-guessed.
 */
function resolveNodeRole(
  node: Record<string, unknown>,
  where: string,
  options: ParseOptions
): Role {
  const role = optionalString(node.role, `${where}.role`);
  if (role !== null) {
    assert(
      isRole(role),
      new DataError(
        `${where}.role is "${role}", which is not a protocol role`,
        {
          hint: `use one of: ${ROLE_LIST}.`,
        }
      )
    );
    return role;
  }

  const state = optionalString(node.state, `${where}.state`);
  assert(
    state !== null,
    new DataError(`${where} carries neither a "role" nor a native "state"`, {
      hint: 'give each node the tracker\'s native state (e.g. {"state": "In Progress"}), or a resolved protocol role.',
    })
  );

  return resolveRole(options.tracker, state, options.config.states);
}

function resolveTargetKind(
  explicit: unknown,
  labels: readonly string[],
  where: string,
  config: GraphConfig
): TargetKind {
  const kind = optionalString(explicit, `${where}.targetKind`);
  if (kind !== null) {
    assert(
      isTargetKind(kind),
      new DataError(
        `${where}.targetKind is "${kind}", which is not a target kind`,
        {hint: `use one of: ${TARGET_KIND_LIST}.`}
      )
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
    new DataError('the payload\'s "projects" must be an array', {
      hint: 'emit {"projects": [{"id": "...", "name": "..."}]}.',
    })
  );

  return raw.map((entry, index) => {
    const where = `projects[${String(index)}]`;
    const project = asObject(entry, where);
    const id = requireString(project.id, `${where}.id`);

    return {
      id,
      name: optionalString(project.name, `${where}.name`) ?? id,
      declared: true,
    };
  });
}

function parseMilestones(raw: unknown): Milestone[] {
  if (raw === undefined || raw === null) return [];

  assert(
    Array.isArray(raw),
    new DataError('the payload\'s "milestones" must be an array', {
      hint: 'emit {"milestones": [{"id": "...", "project": "...", "name": "...", "sortOrder": 0}]}.',
    })
  );

  return raw.map((entry, index) => {
    const where = `milestones[${String(index)}]`;
    const milestone = asObject(entry, where);
    const id = requireString(milestone.id, `${where}.id`);

    const sortOrder = optionalNumber(
      pick(milestone, 'sortOrder', 'sort_order'),
      `${where}.sortOrder`
    );
    assert(
      sortOrder !== null,
      new DataError(`milestone ${id} has no sortOrder`, {
        hint: 'milestone order decides which milestones gate which — fetch it from the tracker (Linear: list_milestones returns sortOrder) rather than leaving it out.',
      })
    );

    return {
      id,
      project: requireString(milestone.project, `${where}.project`),
      name: optionalString(milestone.name, `${where}.name`) ?? id,
      sortOrder,
    };
  });
}

/**
 * The cursor is opaque to us: whatever the tracker means by "changed since"
 * (Linear an `updatedAt`, GitHub a `since`). We store it and hand it back.
 */
function parseCursors(
  doc: Record<string, unknown>,
  source: string
): Record<string, string> {
  const single = optionalString(doc.cursor, 'cursor');
  if (single !== null) return {[source]: single};

  if (doc.cursors === undefined || doc.cursors === null) return {};
  const cursors = asObject(doc.cursors, 'cursors');

  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(cursors)) {
    const cursor = optionalString(value, `cursors.${key}`);
    assert(
      cursor !== null,
      new DataError(`cursors.${key} must be a non-empty string`, {
        hint: 'a cursor is an opaque tracker token — pass it through unchanged.',
      })
    );
    out[key] = cursor;
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
    new DataError(`${where} must be a JSON object`, {
      hint: 'see the build-graph skill reference for the payload shape.',
    })
  );

  return raw as Record<string, unknown>;
}

function requireString(raw: unknown, where: string): string {
  assert(
    typeof raw === 'string' && raw.trim() !== '',
    new DataError(`${where} is required and must be a non-empty string`, {
      hint: 'every ticket needs its tracker identifier (e.g. "CLC-945") and its project.',
    })
  );

  return raw.trim();
}

/**
 * A missing optional field is null. A number is accepted and stringified — some
 * trackers hand back numeric ids.
 *
 * Anything else (an object, an array, a boolean) is a malformed payload and is
 * REJECTED, not coerced. Coercing would be worse than useless here:
 * `{"milestone": {"id": "m1"}}` — the shape Linear's API actually returns —
 * would silently drop the ticket out of its milestone, and it would escape the
 * milestone gate with nothing to show for it.
 */
function optionalString(raw: unknown, where: string): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);

  assert(
    typeof raw === 'string',
    new DataError(`${where} must be a string, but got ${describeType(raw)}`, {
      hint: 'pass the plain value — a milestone id as "m1", not {"id": "m1"}.',
    })
  );

  return raw.trim() === '' ? null : raw.trim();
}

/** An optional boolean. The string "true" is not a boolean, and never means one. */
function optionalBoolean(raw: unknown, where: string): boolean | undefined {
  if (raw === undefined || raw === null) return undefined;

  assert(
    typeof raw === 'boolean',
    new DataError(
      `${where} must be true or false, but got ${describeType(raw)}`,
      {
        hint: 'emit a JSON boolean, not a string: {"deleted": true}, never {"deleted": "true"}.',
      }
    )
  );

  return raw;
}

function optionalNumber(raw: unknown, where: string): number | null {
  if (raw === undefined || raw === null) return null;

  assert(
    typeof raw === 'number' && Number.isFinite(raw),
    new DataError(`${where} must be a finite number`, {
      hint: 'omit it entirely if the tracker does not provide one.',
    })
  );

  return raw;
}

function stringArray(raw: unknown, where: string): string[] {
  if (raw === undefined || raw === null) return [];

  assert(
    Array.isArray(raw) && raw.every((value) => typeof value === 'string'),
    new DataError(`${where} must be an array of strings`, {
      hint: 'emit e.g. ["CLC-901", "CLC-902"].',
    })
  );

  return raw
    .map((value: string) => value.trim())
    .filter((value) => value !== '');
}

function describeType(raw: unknown): string {
  if (Array.isArray(raw)) return 'an array';
  if (typeof raw === 'object') return 'an object';
  return `${typeof raw} ${JSON.stringify(raw)}`;
}
