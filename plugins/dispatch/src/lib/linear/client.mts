import {DataError, ensure} from '../errors/index.mts';
import {
  ISSUES_QUERY,
  ISSUE_IDENTIFIERS_QUERY,
  ISSUE_QUERY,
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

/** The loop guard: no query this module sends has a legitimate thousandth page. */
const MAX_PAGES = 1000;

/** Linear issue numbers start at 1, and its comparators reject anything past a 32-bit int. */
const IDENTIFIER = /^(?<key>[A-Za-z0-9]+)-(?<number>[1-9]\d{0,8})$/u;

interface RawPage<TNode> {
  nodes?: TNode[] | null;
  pageInfo?: {hasNextPage?: boolean; endCursor?: string | null} | null;
}

interface RawRelation {
  type?: string;
  relatedIssue?: {identifier?: string} | null;
  issue?: {identifier?: string} | null;
}

interface RawIssue {
  id?: string;
  identifier?: string;
  title?: string;
  url?: string;
  priority?: number;
  branchName?: string;
  updatedAt?: string;
  archivedAt?: string | null;
  state?: {name?: string; type?: string} | null;
  project?: {id?: string} | null;
  projectMilestone?: {id?: string} | null;
  labels?: RawPage<{name?: string}> | null;
  relations?: RawPage<RawRelation> | null;
  inverseRelations?: RawPage<RawRelation> | null;
}

function page<TNode>(raw: RawPage<TNode> | null | undefined): Page<TNode> {
  return {
    nodes: raw?.nodes ?? [],
    pageInfo: {
      hasNextPage: raw?.pageInfo?.hasNextPage === true,
      endCursor: raw?.pageInfo?.endCursor ?? null,
    },
  };
}

/**
 * Walk a connection to its end.
 *
 * The cursor checks are not paranoia about Linear: a page that reports more
 * pages but cannot say where to resume is an infinite loop inside a server
 * tick, and a loop that reports itself is worth the few lines.
 */
async function collect<TNode>(
  load: (after: string | null) => Promise<Page<TNode>>
): Promise<TNode[]> {
  const all: TNode[] = [];
  let after: string | null = null;
  for (let pages = 0; pages < MAX_PAGES; pages += 1) {
    const current: Page<TNode> = await load(after);
    all.push(...current.nodes);
    if (!current.pageInfo.hasNextPage) return all;
    const next = current.pageInfo.endCursor;
    ensure(
      next !== null,
      () =>
        new DataError('linear reported another page but no cursor to read it', {
          hint: 'retry the scan; if it repeats, the query asks for a connection Linear cannot page.',
        })
    );
    ensure(
      next !== after,
      () =>
        new DataError('linear paged without advancing its cursor', {
          hint: 'retry the scan; if it repeats, the query asks for a connection Linear cannot page.',
        })
    );
    after = next;
  }
  throw new DataError(
    `linear was still paging after ${String(MAX_PAGES)} pages`,
    {
      hint: 'scan a narrower project, or pass a cursor so the delta is smaller.',
    }
  );
}

/**
 * Read a nested connection that is never paged, refusing one that overflowed.
 *
 * Truncation here is silent data loss into a scheduling graph — half an
 * issue's blockers look exactly like all of them — so it is a failure, not a
 * warning nobody reads.
 */
function nested<TNode>(
  raw: RawPage<TNode> | null | undefined,
  connection: string,
  issue: string
): readonly TNode[] {
  ensure(
    raw?.pageInfo?.hasNextPage !== true,
    () =>
      new DataError(
        `${issue} has more than ${String(NESTED_PAGE_SIZE)} ${connection}`,
        {
          hint: `this client cannot see past the first ${String(NESTED_PAGE_SIZE)}; split the ticket, or raise NESTED_PAGE_SIZE in the dispatch Linear client.`,
        }
      )
  );
  return raw?.nodes ?? [];
}

/**
 * A blocking relation is one row Linear shows from both ends: the blocker
 * lists it under `relations`, the blocked issue under `inverseRelations`.
 * Which end we are reading is the only thing that says which direction it
 * points, so the direction is decided here and nowhere else.
 */
function related(
  nodes: readonly RawRelation[],
  side: 'relatedIssue' | 'issue'
): string[] {
  const found = nodes
    .filter((node) => node.type === 'blocks')
    .map((node) => node[side]?.identifier ?? '')
    .filter((identifier) => identifier !== '');
  return [...new Set(found)].sort((a, b) => a.localeCompare(b));
}

function parseIssue(raw: RawIssue): LinearIssue {
  const identifier = raw.identifier ?? '';
  return {
    id: raw.id ?? '',
    identifier,
    title: raw.title ?? '',
    url: raw.url ?? '',
    state: {name: raw.state?.name ?? '', type: raw.state?.type ?? ''},
    priority: raw.priority ?? 0,
    labels: nested(raw.labels, 'labels', identifier)
      .map((node) => node.name ?? '')
      .filter((name) => name !== ''),
    branchName: raw.branchName ?? '',
    updatedAt: raw.updatedAt ?? '',
    archivedAt: raw.archivedAt ?? null,
    projectId: raw.project?.id ?? null,
    milestoneId: raw.projectMilestone?.id ?? null,
    blocks: related(
      nested(raw.relations, 'relations', identifier),
      'relatedIssue'
    ),
    blockedBy: related(
      nested(raw.inverseRelations, 'inverse relations', identifier),
      'issue'
    ),
  };
}

function issueFilter(project: string, updatedSince?: string | null): object {
  const filter: Record<string, unknown> = {project: {id: {eq: project}}};
  if (updatedSince != null && updatedSince !== '') {
    // Inclusive: two issues saved in the same millisecond can straddle a page
    // boundary, and `ticket set` is idempotent, so re-reading the boundary
    // costs a write while skipping it loses the ticket for good.
    filter.updatedAt = {gte: updatedSince};
  }
  return filter;
}

/**
 * Reads of the Linear workspace the graph is built from. Every list pages to
 * completion, so a caller never handles a GraphQL cursor; the only cursor it
 * deals in is the delta one, which is a timestamp.
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
    select: {readonly id?: string; readonly name?: string} = {}
  ): Promise<LinearProject[]> {
    const filter: Record<string, unknown> = {};
    if (select.id !== undefined) filter.id = {eq: select.id};
    if (select.name !== undefined) filter.name = {eq: select.name};
    const nodes = await collect<{id?: string; name?: string}>(async (after) => {
      const data = await this.#execute<{
        projects?: RawPage<{id?: string; name?: string}> | null;
      }>({
        query: PROJECTS_QUERY,
        variables: {
          filter: Object.keys(filter).length === 0 ? null : filter,
          first: PAGE_SIZE,
          after,
        },
      });
      return page(data.projects);
    });
    return nodes.map((project) => ({
      id: project.id ?? '',
      name: project.name ?? '',
    }));
  }

  /** A project's milestones, ascending by the order Linear keeps them in. */
  async listMilestones(projectId: string): Promise<LinearMilestone[]> {
    const nodes = await collect<{
      id?: string;
      name?: string;
      sortOrder?: number;
    }>(async (after) => {
      const data = await this.#execute<{
        project?: {
          projectMilestones?: RawPage<{
            id?: string;
            name?: string;
            sortOrder?: number;
          }> | null;
        } | null;
      }>({
        query: MILESTONES_QUERY,
        variables: {project: projectId, first: PAGE_SIZE, after},
      });
      return page(data.project?.projectMilestones);
    });
    return nodes
      .map((milestone) => ({
        id: milestone.id ?? '',
        name: milestone.name ?? '',
        sortOrder: milestone.sortOrder ?? 0,
      }))
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
  async listIssues(input: {
    readonly project: string;
    readonly updatedSince?: string | null;
  }): Promise<LinearIssue[]> {
    const filter = issueFilter(input.project, input.updatedSince);
    const nodes = await collect<RawIssue>(async (after) => {
      const data = await this.#execute<{issues?: RawPage<RawIssue> | null}>({
        query: ISSUES_QUERY,
        variables: {filter, first: ISSUE_PAGE_SIZE, after},
      });
      return page(data.issues);
    });
    return nodes.map(parseIssue);
  }

  /**
   * Every identifier currently in the project, delta or not. A delta can say
   * what changed but never what left: a ticket moved to another project or
   * deleted simply stops appearing. This is the cheap full list to reconcile
   * the graph's membership against.
   */
  async listIssueIdentifiers(projectId: string): Promise<string[]> {
    const nodes = await collect<{identifier?: string}>(async (after) => {
      const data = await this.#execute<{
        issues?: RawPage<{identifier?: string}> | null;
      }>({
        query: ISSUE_IDENTIFIERS_QUERY,
        variables: {
          filter: issueFilter(projectId),
          first: PAGE_SIZE,
          after,
        },
      });
      return page(data.issues);
    });
    return nodes
      .map((node) => node.identifier ?? '')
      .filter((identifier) => identifier !== '');
  }

  /** One issue by identifier, or `null` when the workspace has no such issue. */
  async getIssue(identifier: string): Promise<LinearIssue | null> {
    const match = IDENTIFIER.exec(identifier.trim());
    ensure(
      match?.groups !== undefined,
      () =>
        new DataError(`"${identifier}" is not a Linear issue identifier`, {
          hint: 'use the team-prefixed form, e.g. CLC-1159.',
        })
    );
    const {key, number} = match.groups as {key: string; number: string};
    const data = await this.#execute<{issues?: RawPage<RawIssue> | null}>({
      query: ISSUE_QUERY,
      variables: {
        filter: {
          team: {key: {eqIgnoreCase: key}},
          number: {eq: Number(number)},
        },
      },
    });
    const found = page(data.issues).nodes[0];
    return found === undefined ? null : parseIssue(found);
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
