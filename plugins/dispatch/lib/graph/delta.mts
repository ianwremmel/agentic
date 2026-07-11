/**
 * Reads the XML delta a tracker adapter emits into the internal shape.
 *
 * The adapter (`graph-fetch-<tracker>`) is the only tracker-specific component
 * in the stack; this is the seam it writes to. Unknown roles and target kinds
 * are rejected here rather than corrupting the scheduling downstream.
 */

import {bool, childrenNamed, num, parse, type Element} from './xml.mts';
import {PARKED, TERMINAL, type Delta, type Edge, type Milestone, type Node, type Project, type Role, type TargetKind} from './types.mts';

const ROLES: ReadonlySet<string> = new Set([
  'backlog',
  'available',
  'in-progress',
  'in-review',
  'finished',
  'delivered',
  ...TERMINAL,
  ...PARKED,
]);

const TARGET_KINDS: ReadonlySet<string> = new Set(['pr', 'verification', 'human-only']);

function role(element: Element): Role {
  const raw = element.attrs.role;
  if (raw === undefined) throw new Error(`<node id="${element.attrs.id}"> has no role`);
  if (!ROLES.has(raw))
    throw new Error(`unknown role "${raw}" on node ${element.attrs.id} — map the tracker substate first`);
  return raw as Role;
}

function targetKind(element: Element): TargetKind | undefined {
  const raw = element.attrs['target-kind'];
  if (raw === undefined) return undefined;
  if (!TARGET_KINDS.has(raw)) throw new Error(`unknown target-kind "${raw}" on node ${element.attrs.id}`);
  return raw as TargetKind;
}

function id(element: Element): string {
  const raw = element.attrs.id;
  if (!raw) throw new Error(`<${element.name}> has no id`);
  return raw;
}

/** `<project id="…" name="…" removed="true"?/>` */
function project(element: Element): Project {
  return {id: id(element), name: element.attrs.name, removed: bool(element, 'removed')};
}

/**
 * Drop keys whose value is undefined.
 *
 * Load-bearing: `merge` spreads a delta item over the cached one, and an own key
 * holding `undefined` would *erase* the cached value. A delta that restates a
 * node's role must not silently blank its milestone.
 */
function defined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

/** `<milestone id="…" project="…" order="1" review-recorded="false"/>` */
function milestone(element: Element): Milestone {
  if (bool(element, 'removed')) return {id: id(element), removed: true} as Milestone;
  const order = num(element, 'order');
  if (order === undefined)
    throw new Error(`milestone ${id(element)} has no order — the review gate needs it`);
  const project = element.attrs.project;
  // Without a project, every project-less milestone would share one pseudo-project
  // and gate the others by order alone.
  if (!project) throw new Error(`milestone ${id(element)} has no project`);
  return defined({
    id: id(element),
    project,
    name: element.attrs.name,
    order,
    review_recorded: bool(element, 'review-recorded'),
  });
}

/** `<node id="…" url="…" title="…" role="…" …><label name="x"/><pr url="…"/></node>` */
function node(element: Element): Node {
  if (bool(element, 'removed')) return {id: id(element), removed: true};

  const labels = childrenNamed(element, 'label').map((l) => {
    if (!l.attrs.name) throw new Error(`<label> on node ${id(element)} has no name`);
    return l.attrs.name;
  });
  const prs = childrenNamed(element, 'pr').map((p) => {
    if (!p.attrs.url) throw new Error(`<pr> on node ${id(element)} has no url`);
    return p.attrs.url;
  });

  return defined({
    id: id(element),
    url: element.attrs.url,
    title: element.attrs.title,
    role: role(element),
    group: element.attrs.group,
    project: element.attrs.project,
    milestone: element.attrs.milestone,
    target_kind: targetKind(element),
    human_interactive: bool(element, 'human-interactive'),
    dead: bool(element, 'dead'),
    priority: num(element, 'priority'),
    branch_hint: element.attrs['branch-hint'],
    // Only when stated: an absent <label>/<pr> means "unchanged", not "none".
    labels: labels.length > 0 ? labels : undefined,
    pr_urls: prs.length > 0 ? prs : undefined,
  });
}

/** `<edge blocker="A" blocked="B"/>` — A blocks B. */
function edge(element: Element): Edge {
  const blocker = element.attrs.blocker;
  const blocked = element.attrs.blocked;
  if (!blocker || !blocked) throw new Error('<edge> needs both blocker and blocked');
  if (blocker === blocked) throw new Error(`self-blocking edge on ${blocker}`);
  return defined({blocker, blocked, removed: bool(element, 'removed')});
}

/**
 * Parse an adapter's `<project-graph-delta>` document.
 *
 * @param xml the adapter's output
 * @returns the delta, ready for {@link merge}
 */
export function readDelta(xml: string): Delta {
  const root = parse(xml);
  if (root.name !== 'project-graph-delta')
    throw new Error(`expected <project-graph-delta>, got <${root.name}>`);

  const section = (name: string, item: string): Element[] => {
    const found = root.children.find((c) => c.name === name);
    return found ? childrenNamed(found, item) : [];
  };

  return {
    full: bool(root, 'full'),
    cursor: root.attrs.cursor ?? null,
    projects: section('projects', 'project').map(project),
    milestones: section('milestones', 'milestone').map(milestone),
    nodes: section('nodes', 'node').map(node),
    edges: section('edges', 'edge').map(edge),
    edges_for: section('edges', 'edges-for').map((e) => e.attrs.node ?? ''),
  };
}
