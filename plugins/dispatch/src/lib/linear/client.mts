import type {LinearDocument} from '@linear/sdk';

import {DataError, ensure} from '../errors/index.mts';
import {
  nameRow,
  requireField,
  requireKey,
  requireSortOrder,
} from './fields.mts';
import {
  ISSUE_PAGE_SIZE,
  PAGE_SIZE,
  buildMalformedError,
  collectPages,
  readPage,
} from './paging.mts';
import type {RawPage} from './paging.mts';
import {parseIssue} from './parse-issue.mts';
import type {RawIssue} from './parse-issue.mts';
import {
  ISSUES_QUERY,
  ISSUE_IDENTIFIERS_QUERY,
  ISSUE_QUERY,
  MILESTONES_QUERY,
  PROJECTS_QUERY,
} from './queries/index.mts';
import {requireLinearToken} from './token.mts';
import {createTransport} from './transport.mts';
import type {GraphqlExecutor, TransportOptions} from './transport.mts';
import type {LinearMilestone, LinearProject, LinearIssue} from './types.mts';

/** Linear issue numbers start at 1, and its `number` comparator takes a 32-bit int. */
const IDENTIFIER = /^(?<key>[A-Za-z0-9]+)-(?<number>[1-9]\d{0,9})$/u;
const MAX_ISSUE_NUMBER = 2_147_483_647;

interface RawProject {
  id?: string | null;
  name?: string | null;
}

interface RawMilestone {
  id?: string | null;
  name?: string | null;
  sortOrder?: number | null;
}

function buildIssueFilter(
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
    const nodes = await collectPages<RawProject>(async (after) => {
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
      return readPage(data.projects, 'projects');
    });
    return nodes.map((project) => {
      const of = `project ${nameRow(project.id, project.name)}`;
      return {
        id: requireKey(project.id, 'id', of),
        name: requireField(project.name, 'name', of),
      };
    });
  }

  /** A project's milestones, ascending by the order Linear keeps them in. */
  async listMilestones(
    projectId: string,
    options: ReadOptions = {}
  ): Promise<LinearMilestone[]> {
    const nodes = await collectPages<RawMilestone>(async (after) => {
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
      return readPage(project.projectMilestones, `milestones of ${projectId}`);
    });
    return nodes
      .map((milestone) => {
        const of = `milestone ${nameRow(milestone.id, milestone.name)} of ${projectId}`;
        return {
          id: requireKey(milestone.id, 'id', of),
          name: requireField(milestone.name, 'name', of),
          // Defaulting this to 0 would sort an unordered milestone first,
          // which is a different milestone sequence, not a missing field.
          sortOrder: requireSortOrder(milestone.sortOrder, of),
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
    const filter = buildIssueFilter(input.project, input.updatedSince);
    const nodes = await collectPages<RawIssue>(async (after) => {
      const data = await this.#execute<{issues?: RawPage<RawIssue> | null}>({
        query: ISSUES_QUERY,
        variables: {filter, first: ISSUE_PAGE_SIZE, after},
        signal: options.signal,
      });
      return readPage(data.issues, `issues of ${input.project}`);
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
    const nodes = await collectPages<{identifier?: string | null}>(
      async (after) => {
        const data = await this.#execute<{
          issues?: RawPage<{identifier?: string | null}> | null;
        }>({
          query: ISSUE_IDENTIFIERS_QUERY,
          variables: {
            filter: buildIssueFilter(projectId),
            first: PAGE_SIZE,
            after,
          },
          signal: options.signal,
        });
        return readPage(data.issues, `issues of ${projectId}`);
      }
    );
    // Dropped rather than refused, a missing identifier shortens this list,
    // and a ticket missing from it does not read as a broken answer — it reads
    // as a ticket that left the project, which the caller removes from the
    // graph along with its edges.
    return nodes.map((node) =>
      requireKey(node.identifier, 'identifier', `an issue of ${projectId}`)
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
    ensure(Array.isArray(nodes), () =>
      buildMalformedError(`issue ${identifier}`)
    );
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
