import {DataError, ensure} from '../errors/index.mts';
import {
  ISSUES_QUERY,
  ISSUE_QUERY,
  MILESTONES_QUERY,
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

/** Linear caps a page at 250. Issues carry nested connections, so they ask for less. */
const PAGE_SIZE = 100;
const ISSUE_PAGE_SIZE = 50;

/** 50k issues is past any real project; past this the server is looping us. */
const MAX_PAGES = 1000;

const IDENTIFIER = /^(?<key>[A-Za-z0-9]+)-(?<number>\d+)$/u;

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
 * The cursor guard is not paranoia about Linear: a page that reports more
 * pages while handing back the cursor it was given is an infinite loop inside
 * a server tick, and a loop that reports itself is worth the four lines.
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
      next !== null && next !== after,
      () =>
        new DataError('linear paged without advancing its cursor', {
          hint: 'retry the scan; if it repeats, the query asks for a connection Linear cannot page.',
        })
    );
    after = next;
  }
  throw new DataError(
    `linear returned more than ${String(MAX_PAGES)} pages for one query`,
    {
      hint: 'narrow the scan with a cursor, or raise MAX_PAGES if a project really is that large.',
    }
  );
}

function names(raw: RawPage<{name?: string}> | null | undefined): string[] {
  return (raw?.nodes ?? [])
    .map((node) => node.name ?? '')
    .filter((name) => name !== '');
}

/**
 * A blocking relation is one row Linear shows from both ends: the blocker
 * lists it under `relations`, the blocked issue under `inverseRelations`.
 * Which end we are reading is the only thing that says which direction it
 * points, so the direction is decided here and nowhere else.
 */
function related(
  raw: RawPage<RawRelation> | null | undefined,
  side: 'relatedIssue' | 'issue'
): string[] {
  const found = (raw?.nodes ?? [])
    .filter((node) => node.type === 'blocks')
    .map((node) => node[side]?.identifier ?? '')
    .filter((identifier) => identifier !== '');
  return [...new Set(found)].sort((a, b) => a.localeCompare(b));
}

function parseIssue(raw: RawIssue): LinearIssue {
  return {
    id: raw.id ?? '',
    identifier: raw.identifier ?? '',
    title: raw.title ?? '',
    url: raw.url ?? '',
    state: {name: raw.state?.name ?? '', type: raw.state?.type ?? ''},
    priority: raw.priority ?? 0,
    labels: names(raw.labels),
    branchName: raw.branchName ?? '',
    updatedAt: raw.updatedAt ?? '',
    projectId: raw.project?.id ?? null,
    milestoneId: raw.projectMilestone?.id ?? null,
    blocks: related(raw.relations, 'relatedIssue'),
    blockedBy: related(raw.inverseRelations, 'issue'),
  };
}

/**
 * Reads of the Linear workspace the graph is built from. Every method pages
 * to completion, so a caller never handles a cursor; the only cursor it deals
 * in is the delta one, which is a timestamp.
 */
export class LinearClient {
  readonly #execute: GraphqlExecutor;

  constructor(execute: GraphqlExecutor) {
    this.#execute = execute;
  }

  /** Every project the key can see, so a scan can resolve one named by id or by name. */
  async listProjects(): Promise<LinearProject[]> {
    const nodes = await collect<LinearProject>(async (after) => {
      const data = await this.#execute<{
        projects?: RawPage<LinearProject> | null;
      }>({
        query: PROJECTS_QUERY,
        variables: {first: PAGE_SIZE, after},
      });
      return page(data.projects);
    });
    return nodes.map((project) => ({
      id: project.id,
      name: project.name,
      url: project.url,
      updatedAt: project.updatedAt,
    }));
  }

  /** A project's milestones, in the order Linear holds them. */
  async listMilestones(projectId: string): Promise<LinearMilestone[]> {
    const nodes = await collect<LinearMilestone>(async (after) => {
      const data = await this.#execute<{
        project?: {projectMilestones?: RawPage<LinearMilestone> | null} | null;
      }>({
        query: MILESTONES_QUERY,
        variables: {project: projectId, first: PAGE_SIZE, after},
      });
      return page(data.project?.projectMilestones);
    });
    return [...nodes].sort((a, b) => a.sortOrder - b.sortOrder);
  }

  /**
   * A project's issues, with their blocking relations already in hand — the
   * whole reason to hold a GraphQL client rather than drive the MCP tools,
   * which need a second call per issue to learn the same thing.
   *
   * `updatedAfter` is the delta cursor: pass the newest `updatedAt` the last
   * scan saw and only what moved since comes back. A status change and a
   * relation change both bump it, so one delta carries both.
   */
  async listIssues(input: {
    readonly project: string;
    readonly updatedAfter?: string | null;
  }): Promise<LinearIssue[]> {
    const filter: Record<string, unknown> = {
      project: {id: {eq: input.project}},
    };
    if (input.updatedAfter != null && input.updatedAfter !== '') {
      filter.updatedAt = {gt: input.updatedAfter};
    }
    const nodes = await collect<RawIssue>(async (after) => {
      const data = await this.#execute<{issues?: RawPage<RawIssue> | null}>({
        query: ISSUES_QUERY,
        variables: {filter, first: ISSUE_PAGE_SIZE, after},
      });
      return page(data.issues);
    });
    return nodes.map(parseIssue);
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
          team: {key: {eq: key.toUpperCase()}},
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
