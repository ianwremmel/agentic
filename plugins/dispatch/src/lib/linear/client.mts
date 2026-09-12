import type {LinearDocument} from '@linear/sdk';

import {DataError, EnvironmentError, ensure} from '../errors/index.mts';
import {
  ISSUES_QUERY,
  ISSUE_IDENTIFIERS_QUERY,
  ISSUE_INVERSE_RELATIONS_QUERY,
  ISSUE_LABELS_QUERY,
  ISSUE_QUERY,
  ISSUE_RELATIONS_QUERY,
  MILESTONES_QUERY,
  NESTED_PAGE_SIZE,
  PROJECTS_QUERY,
} from './queries.mts';
import {createTransport, requireLinearToken} from './transport.mts';
import type {GraphqlExecutor, TransportOptions} from './transport.mts';
import type {
  LinearIssue,
  LinearMilestone,
  LinearProject,
  Page,
} from './types.mts';

/** Linear pages at 50 by default and accepts more; issues carry nested connections, so they ask for less. */
const PAGE_SIZE = 100;
const ISSUE_PAGE_SIZE = 50;

/**
 * The bound on one walk. Cursors are checked for advancing, so this is the
 * backstop for a connection that repeats itself in a way a single cursor
 * comparison cannot see: at these page sizes, 100,000 projects or 50,000
 * issues in one project. A project past that has to be read as deltas.
 */
const MAX_PAGES = 1000;

/** Linear issue numbers start at 1, and its `number` comparator takes a 32-bit int. */
const IDENTIFIER = /^(?<key>[A-Za-z0-9]+)-(?<number>[1-9]\d{0,9})$/u;
const MAX_ISSUE_NUMBER = 2_147_483_647;

interface RawPage<TNode> {
  nodes?: TNode[] | null;
  pageInfo?: {hasNextPage?: boolean; endCursor?: string | null} | null;
}

/**
 * Every scalar is nullable, because GraphQL says "this did not come back" with
 * `null` rather than by dropping the key. Typing them as merely optional is
 * what lets a `null` slip past a guard that only asks about `undefined`.
 */
interface RawRelation {
  type?: string | null;
  relatedIssue?: {identifier?: string | null} | null;
  issue?: {identifier?: string | null} | null;
}

interface RawLabel {
  name?: string | null;
}

interface RawProject {
  id?: string | null;
  name?: string | null;
}

interface RawMilestone {
  id?: string | null;
  name?: string | null;
  sortOrder?: number | null;
}

interface RawIssue {
  id?: string | null;
  identifier?: string | null;
  title?: string | null;
  url?: string | null;
  priority?: number | null;
  branchName?: string | null;
  updatedAt?: string | null;
  archivedAt?: string | null;
  state?: {name?: string | null; type?: string | null} | null;
  project?: {id?: string | null} | null;
  projectMilestone?: {id?: string | null} | null;
  labels?: RawPage<RawLabel> | null;
  relations?: RawPage<RawRelation> | null;
  inverseRelations?: RawPage<RawRelation> | null;
}

/** Which of an issue's nested connections a follow-up request is resuming. */
type NestedField = 'labels' | 'relations' | 'inverseRelations';

interface NestedConnection {
  readonly field: NestedField;
  readonly query: string;
}

const LABELS: NestedConnection = {field: 'labels', query: ISSUE_LABELS_QUERY};
const RELATIONS: NestedConnection = {
  field: 'relations',
  query: ISSUE_RELATIONS_QUERY,
};
const INVERSE_RELATIONS: NestedConnection = {
  field: 'inverseRelations',
  query: ISSUE_INVERSE_RELATIONS_QUERY,
};

interface NestedData<TNode> {
  issue?: Partial<Record<NestedField, RawPage<TNode> | null>> | null;
}

/** The executor plus the caller's cancellation, for reads an issue turns out to need. */
interface Continuation {
  readonly execute: GraphqlExecutor;
  readonly signal: AbortSignal | undefined;
}

function malformed(connection: string): EnvironmentError {
  return new EnvironmentError(
    `linear answered without the ${connection} it was asked for`,
    {
      hint: "retry the scan; if it repeats, either something is answering in Linear's place or the query names a connection Linear no longer has.",
    }
  );
}

/**
 * How an error names the row it is about: whichever identifying field did come
 * back, so a hundred-row page says which one failed rather than only that one
 * did. Blank counts as absent — a blank label names nothing.
 */
function rowLabel(...candidates: (string | null | undefined)[]): string {
  return (
    candidates.find((value) => value != null && value !== '') ??
    '(unidentified)'
  );
}

function dropped(field: string, of: string): EnvironmentError {
  return new EnvironmentError(
    `linear answered without the ${field} of ${of} it was asked for`,
    {
      hint: "retry the scan; if it repeats, either something is answering in Linear's place or the query no longer selects that field.",
    }
  );
}

/**
 * A field the query selects, refused when it did not come back rather than
 * defaulted. GraphQL reports an absent field as `null` rather than by dropping
 * the key, so both are refused — asking only about `undefined` would pass the
 * shape Linear actually sends.
 */
function present<TValue>(
  value: TValue | null | undefined,
  field: string,
  of: string
): TValue {
  ensure(value !== null && value !== undefined, () => dropped(field, of));
  return value;
}

/**
 * A field something is matched on: an id, an identifier, a workflow state.
 * Empty is refused as well as absent, because `''` reaches the graph as a
 * project nothing matches, which reads exactly like a project with no work in
 * it. A display name is deliberately not this — an oddly named row is still a
 * real row, and refusing it would fail the whole scan over one of them.
 */
function matched(
  value: string | null | undefined,
  field: string,
  of: string
): string {
  const found = present(value, field, of);
  ensure(found !== '', () => dropped(field, of));
  return found;
}

/** Linear orders milestones by this, so a value that cannot be compared is not one. */
function ordered(value: number | null | undefined, of: string): number {
  const found = present(value, 'sortOrder', of);
  ensure(Number.isFinite(found), () => dropped('sortOrder', of));
  return found;
}

/**
 * One page of a connection, refusing a response that cannot say whether more
 * follow. Every query here selects `nodes` and `pageInfo`, so an absent one
 * means a malformed answer — and reading that as "no further pages" would turn
 * a broken response into a short list the caller has no reason to doubt.
 */
function page<TNode>(
  raw: RawPage<TNode> | null | undefined,
  connection: string
): Page<TNode> {
  const nodes = raw?.nodes;
  const info = raw?.pageInfo;
  ensure(Array.isArray(nodes), () => malformed(connection));
  ensure(info !== null && info !== undefined, () => malformed(connection));
  return {
    nodes,
    pageInfo: {
      hasNextPage: info.hasNextPage === true,
      endCursor: info.endCursor ?? null,
    },
  };
}

/**
 * Walk a connection to its end, either from the start or on from a page already
 * in hand.
 *
 * The cursor checks are not paranoia about Linear: a page that reports more
 * pages but cannot say where to resume is an infinite loop inside a server
 * tick, and a loop that reports itself is worth the few lines.
 */
async function collect<TNode>(
  load: (after: string | null) => Promise<Page<TNode>>,
  first?: Page<TNode>
): Promise<TNode[]> {
  const all: TNode[] = [];
  let after: string | null = null;
  let current = first;
  for (let pages = 0; pages < MAX_PAGES; pages += 1) {
    current ??= await load(after);
    all.push(...current.nodes);
    if (!current.pageInfo.hasNextPage) return all;
    const next = current.pageInfo.endCursor;
    ensure(
      next !== null,
      () =>
        new EnvironmentError(
          'linear reported another page but no cursor to read it',
          {
            hint: 'retry the scan; if it repeats, the query asks for a connection Linear cannot page.',
          }
        )
    );
    ensure(
      next !== after,
      () =>
        new EnvironmentError('linear paged without advancing its cursor', {
          hint: 'retry the scan; if it repeats, the query asks for a connection Linear cannot page.',
        })
    );
    after = next;
    current = undefined;
  }
  throw new DataError(
    `linear was still paging after ${String(MAX_PAGES)} pages`,
    {
      hint: 'scan a narrower project, or pass a cursor so the delta is smaller.',
    }
  );
}

/**
 * All of one issue's nested connection, continuing past the inline page when
 * that page overflowed.
 *
 * Truncation here is silent data loss into a scheduling graph — half an issue's
 * blockers look exactly like all of them — so the overflow is finished with its
 * own request rather than dropped. Only the overflowing issue pays for it.
 */
async function wholeNested<TNode>(
  inline: RawPage<TNode> | null | undefined,
  connection: NestedConnection,
  issue: {readonly id: string; readonly identifier: string},
  more: Continuation
): Promise<readonly TNode[]> {
  const label = `${connection.field} of ${issue.identifier}`;
  const first = page(inline, label);
  if (!first.pageInfo.hasNextPage) return first.nodes;
  return collect<TNode>(async (after) => {
    const data = await more.execute<NestedData<TNode>>({
      query: connection.query,
      variables: {id: issue.id, first: NESTED_PAGE_SIZE, after},
      signal: more.signal,
    });
    const found = data.issue;
    ensure(
      found !== null && found !== undefined,
      () =>
        new DataError(
          `linear has no issue ${issue.identifier} to read the rest of its ${connection.field} from`,
          {
            hint: 'retry the scan; the issue was deleted or moved while it was being read.',
          }
        )
    );
    return page(found[connection.field], label);
  }, first);
}

/**
 * A blocking relation is one row Linear shows from both ends: the blocker
 * lists it under `relations`, the blocked issue under `inverseRelations`.
 * Which end we are reading is the only thing that says which direction it
 * points, so the direction is decided here and nowhere else.
 */
function related(
  nodes: readonly RawRelation[],
  side: 'relatedIssue' | 'issue',
  issue: string
): string[] {
  const found = nodes
    // The type is read before it is compared: dropped, every relation would
    // filter out and the issue would look like it has no blockers at all.
    .filter(
      (node) =>
        present(node.type, 'type', `a relation on ${issue}`) === 'blocks'
    )
    .map((node) => {
      const identifier = node[side]?.identifier ?? '';
      // Dropping this would record an issue as having fewer blockers than it
      // has, which is the one wrong answer a scheduler cannot detect.
      ensure(
        identifier !== '',
        () =>
          new EnvironmentError(
            `linear answered with a blocking relation on ${issue} without naming its other end`,
            {
              hint: 'retry the scan; a blocking edge cannot be recorded from one end alone.',
            }
          )
      );
      return identifier;
    });
  return [...new Set(found)].sort((a, b) => a.localeCompare(b));
}

async function parseIssue(
  raw: RawIssue,
  more: Continuation
): Promise<LinearIssue> {
  // The identifier is how every caller names this ticket, the id is what
  // resumes an overflowing nested connection, the state decides whether the
  // ticket is schedulable, the priority orders the queue, and `updatedAt` is
  // the delta cursor and the milestone-review staleness input. None of them
  // has a safe default, so all of them are read before the nested walks —
  // paying for three of those and then refusing the issue is wasted work.
  const identifier = matched(raw.identifier, 'identifier', 'an issue');
  const state = {
    name: matched(raw.state?.name, 'state name', identifier),
    type: matched(raw.state?.type, 'state type', identifier),
  };
  const priority = present(raw.priority, 'priority', identifier);
  const updatedAt = matched(raw.updatedAt, 'updatedAt', identifier);
  const issue = {id: matched(raw.id, 'id', identifier), identifier};

  const labels = await wholeNested(raw.labels, LABELS, issue, more);
  const blocks = await wholeNested(raw.relations, RELATIONS, issue, more);
  const blockedBy = await wholeNested(
    raw.inverseRelations,
    INVERSE_RELATIONS,
    issue,
    more
  );
  return {
    id: issue.id,
    identifier,
    title: raw.title ?? '',
    url: raw.url ?? '',
    state,
    priority,
    labels: labels.map((node) =>
      present(node.name, 'name', `a label of ${identifier}`)
    ),
    branchName: raw.branchName ?? '',
    updatedAt,
    archivedAt: raw.archivedAt ?? null,
    // A null project or milestone is Linear saying the issue is in neither.
    // One that came back as an object without its id is a dropped selection,
    // and read as "no milestone" it would quietly shrink a milestone's
    // membership — the gate is computed over whoever is left.
    projectId: raw.project
      ? matched(raw.project.id, 'project id', identifier)
      : null,
    milestoneId: raw.projectMilestone
      ? matched(raw.projectMilestone.id, 'milestone id', identifier)
      : null,
    blocks: related(blocks, 'relatedIssue', identifier),
    blockedBy: related(blockedBy, 'issue', identifier),
  };
}

function issueFilter(
  project: string,
  updatedSince?: string | null
): LinearDocument.IssueFilter {
  const filter: LinearDocument.IssueFilter = {project: {id: {eq: project}}};
  if (updatedSince != null && updatedSince !== '') {
    // The cursor goes over the wire as written. `DateTimeOrDuration` takes more
    // than an ISO timestamp — `2021` is that midnight, `-P2W1D` is two weeks
    // and a day ago — and parsing it to a `Date` first would refuse those, drop
    // sub-millisecond precision, and roll a date like Feb 30 into March.
    //
    // Inclusive: two issues saved in the same millisecond can straddle a page
    // boundary, and `ticket set` is idempotent, so re-reading the boundary
    // costs a write while skipping it loses the ticket for good.
    filter.updatedAt = {gte: updatedSince};
  }
  return filter;
}

/** A caller's cancellation, which every read accepts and every page of it honors. */
export interface ReadOptions {
  readonly signal?: AbortSignal;
}

/**
 * Reads of the Linear workspace the graph is built from. Every list walks its
 * connection to the end, so a caller never handles a GraphQL cursor; the only
 * cursor it deals in is the delta one, which is a timestamp.
 *
 * A read is as many round trips as the data needs, so a caller on a server tick
 * passes a `signal` to bound the whole walk — the transport's timeout bounds
 * one request, not the scan.
 */
export class LinearClient {
  readonly #execute: GraphqlExecutor;

  constructor(execute: GraphqlExecutor) {
    this.#execute = execute;
  }

  /**
   * Projects the key can see, narrowed by exact name or id. A scan is handed
   * project names or ids, so it asks Linear to find them rather than reading
   * the whole workspace.
   */
  async listProjects(
    select: {readonly id?: string; readonly name?: string} = {},
    options: ReadOptions = {}
  ): Promise<LinearProject[]> {
    const filter: LinearDocument.ProjectFilter = {};
    if (select.id !== undefined) filter.id = {eq: select.id};
    if (select.name !== undefined) filter.name = {eq: select.name};
    const nodes = await collect<RawProject>(async (after) => {
      const data = await this.#execute<{
        projects?: RawPage<RawProject> | null;
      }>({
        query: PROJECTS_QUERY,
        variables: {
          filter: Object.keys(filter).length === 0 ? null : filter,
          first: PAGE_SIZE,
          after,
        },
        signal: options.signal,
      });
      return page(data.projects, 'projects');
    });
    return nodes.map((project) => {
      const of = `project ${rowLabel(project.id, project.name)}`;
      return {
        id: matched(project.id, 'id', of),
        name: present(project.name, 'name', of),
      };
    });
  }

  /** A project's milestones, ascending by the order Linear keeps them in. */
  async listMilestones(
    projectId: string,
    options: ReadOptions = {}
  ): Promise<LinearMilestone[]> {
    const nodes = await collect<RawMilestone>(async (after) => {
      const data = await this.#execute<{
        project?: {projectMilestones?: RawPage<RawMilestone> | null} | null;
      }>({
        query: MILESTONES_QUERY,
        variables: {project: projectId, first: PAGE_SIZE, after},
        signal: options.signal,
      });
      const project = data.project;
      // A project Linear does not have is not a project with no milestones:
      // the caller would write the second as an emptied milestone set.
      ensure(
        project !== null && project !== undefined,
        () =>
          new DataError(`linear has no project ${projectId}`, {
            hint: 'check the project id; a scan can only read a project the api key can see.',
          })
      );
      return page(project.projectMilestones, `milestones of ${projectId}`);
    });
    return nodes
      .map((milestone) => {
        const of = `milestone ${rowLabel(milestone.id, milestone.name)} of ${projectId}`;
        return {
          id: matched(milestone.id, 'id', of),
          name: present(milestone.name, 'name', of),
          // Defaulting this to 0 would sort an unordered milestone first,
          // which is a different milestone sequence, not a missing field.
          sortOrder: ordered(milestone.sortOrder, of),
        };
      })
      .sort((a, b) => a.sortOrder - b.sortOrder);
  }

  /**
   * A project's issues, with their blocking relations already in hand — the
   * whole reason to hold a GraphQL client rather than drive the MCP tools,
   * which need a second call per issue to learn the same thing.
   *
   * `updatedSince` is the delta filter, and it is inclusive. Take the cursor
   * for the next scan from when this scan *started*, not from the newest
   * `updatedAt` it returned: an issue edited while the scan was paging can
   * land behind the page already read, and a cursor drawn from the rows would
   * step over that edit forever.
   */
  async listIssues(
    input: {
      readonly project: string;
      readonly updatedSince?: string | null;
    },
    options: ReadOptions = {}
  ): Promise<LinearIssue[]> {
    const filter = issueFilter(input.project, input.updatedSince);
    const nodes = await collect<RawIssue>(async (after) => {
      const data = await this.#execute<{issues?: RawPage<RawIssue> | null}>({
        query: ISSUES_QUERY,
        variables: {filter, first: ISSUE_PAGE_SIZE, after},
        signal: options.signal,
      });
      return page(data.issues, `issues of ${input.project}`);
    });
    const more = {execute: this.#execute, signal: options.signal};
    const issues: LinearIssue[] = [];
    for (const node of nodes) {
      issues.push(await parseIssue(node, more));
    }
    return issues;
  }

  /**
   * Every identifier currently in the project, delta or not. A delta can say
   * what changed but never what left: a ticket moved to another project or
   * deleted simply stops appearing. This is the cheap full list to reconcile
   * the graph's membership against.
   */
  async listIssueIdentifiers(
    projectId: string,
    options: ReadOptions = {}
  ): Promise<string[]> {
    const nodes = await collect<{identifier?: string | null}>(async (after) => {
      const data = await this.#execute<{
        issues?: RawPage<{identifier?: string | null}> | null;
      }>({
        query: ISSUE_IDENTIFIERS_QUERY,
        variables: {
          filter: issueFilter(projectId),
          first: PAGE_SIZE,
          after,
        },
        signal: options.signal,
      });
      return page(data.issues, `issues of ${projectId}`);
    });
    // Dropped rather than refused, a missing identifier shortens this list,
    // and a ticket missing from it does not read as a broken answer — it reads
    // as a ticket that left the project, which the caller removes from the
    // graph along with its edges.
    return nodes.map((node) =>
      matched(node.identifier, 'identifier', `an issue of ${projectId}`)
    );
  }

  /** One issue by identifier, or `null` when the workspace has no such issue. */
  async getIssue(
    identifier: string,
    options: ReadOptions = {}
  ): Promise<LinearIssue | null> {
    const match = IDENTIFIER.exec(identifier.trim());
    ensure(
      match?.groups !== undefined,
      () =>
        new DataError(`"${identifier}" is not a Linear issue identifier`, {
          hint: 'use the team-prefixed form, e.g. CLC-1159.',
        })
    );
    const {key, number} = match.groups as {key: string; number: string};
    const issueNumber = Number(number);
    ensure(
      issueNumber <= MAX_ISSUE_NUMBER,
      () =>
        new DataError(
          `"${identifier}" numbers an issue past the largest Linear can hold`,
          {
            hint: 'check the identifier; Linear numbers issues within a 32-bit int.',
          }
        )
    );
    const filter: LinearDocument.IssueFilter = {
      team: {key: {eqIgnoreCase: key}},
      number: {eq: issueNumber},
    };
    const data = await this.#execute<{
      issues?: {nodes?: RawIssue[] | null} | null;
    }>({
      query: ISSUE_QUERY,
      variables: {filter},
      signal: options.signal,
    });
    const nodes = data.issues?.nodes;
    ensure(Array.isArray(nodes), () => malformed(`issue ${identifier}`));
    const found = nodes[0];
    return found === undefined
      ? null
      : parseIssue(found, {execute: this.#execute, signal: options.signal});
  }
}

/**
 * A client authenticated from the environment. Throws when the key is absent,
 * so a caller that means to fall back to the agent path should ask
 * `hasLinearToken` first rather than catch this.
 */
export function createLinearClient(
  env: NodeJS.ProcessEnv,
  options: Omit<TransportOptions, 'token'> = {}
): LinearClient {
  return new LinearClient(
    createTransport({...options, token: requireLinearToken(env)})
  );
}
