import { resolveLinearApiKey, type AuthOptions } from "./auth.mts";
import { LinearError } from "./errors.mts";
import { LinearHttpClient, type HttpClientOptions } from "./http.mts";
import {
  mapLinearState,
  MappingError,
  type LinearStateType,
  type MappingOptions,
  type Role,
  type TicketRole,
} from "./state-mapping.mts";
import type { Project, ReactionContent, Ticket, TicketRef } from "./types.mts";

export type LinearAdapterOptions = AuthOptions &
  Omit<HttpClientOptions, "apiKey"> & {
    apiKey?: string | (() => Promise<string>);
    mapping?: MappingOptions;
  };

const IDENTIFIER_RE = /^[A-Z][A-Z0-9_]*-\d+$/i;

/**
 * Linear adapter for the ticket-workflow protocol (§2.3).
 *
 * Most callers should construct one adapter per workspace.
 */
export class LinearAdapter {
  readonly #http: LinearHttpClient;
  readonly #mapping: MappingOptions;

  constructor(opts: LinearAdapterOptions = {}) {
    const apiKeyFn =
      typeof opts.apiKey === "function"
        ? opts.apiKey
        : typeof opts.apiKey === "string"
          ? async () => opts.apiKey as string
          : (() => {
              let cached: Promise<string> | undefined;
              return () => {
                cached ??= resolveLinearApiKey({
                  env: opts.env,
                  configLookup: opts.configLookup,
                });
                return cached;
              };
            })();
    this.#http = new LinearHttpClient({ ...opts, apiKey: apiKeyFn });
    this.#mapping = opts.mapping ?? {};
  }

  /**
   * Accept either a Linear URL or a `TEAM-123` identifier; return the
   * canonical UUID + identifier pair.
   *
   * Resolution is lazy:
   *   - URL → parse identifier from the path
   *   - identifier → query Linear for the UUID
   */
  async resolveTicket(urlOrId: string): Promise<TicketRef> {
    const id = extractIdentifier(urlOrId);
    const data = await this.#http.graphql<{
      issue: { id: string; identifier: string } | null;
    }>(`query($id: String!) { issue(id: $id) { id identifier } }`, {
      variables: { id },
    });
    if (data.issue === null) {
      throw new LinearError(`Linear ticket not found: ${id}`, {
        kind: "not-found",
      });
    }
    return { id: data.issue.id, identifier: data.issue.identifier };
  }

  async getTicket(idOrIdentifier: string): Promise<Ticket> {
    const data = await this.#http.graphql<{
      issue: RawTicket | null;
    }>(TICKET_QUERY, { variables: { id: idOrIdentifier } });
    if (data.issue === null) {
      throw new LinearError(`Linear ticket not found: ${idOrIdentifier}`, {
        kind: "not-found",
      });
    }
    return this.#materialize(data.issue);
  }

  async listProjectTickets(projectIdOrUrl: string): Promise<Ticket[]> {
    const projectId = extractProjectId(projectIdOrUrl);
    const out: Ticket[] = [];
    let cursor: string | null = null;
    for (;;) {
      const data: {
        project: {
          issues: {
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
            nodes: RawTicket[];
          };
        } | null;
      } = await this.#http.graphql(PROJECT_TICKETS_QUERY, {
        variables: { id: projectId, cursor },
      });
      if (data.project === null) {
        throw new LinearError(`Linear project not found: ${projectId}`, {
          kind: "not-found",
        });
      }
      for (const node of data.project.issues.nodes) {
        out.push(this.#materialize(node));
      }
      if (!data.project.issues.pageInfo.hasNextPage) break;
      cursor = data.project.issues.pageInfo.endCursor;
    }
    return out;
  }

  /**
   * Move a ticket to the workflow state that maps to the given protocol
   * role. The team's own state list is consulted so we never invent
   * states the workspace doesn't have.
   */
  async transitionTicket(
    ticketId: string,
    targetRole: Role,
  ): Promise<{ stateId: string }> {
    const ticket = await this.getTicket(ticketId);
    const stateId = await this.#findStateForRole(
      ticket.team.id,
      targetRole,
      ticket.team.key,
    );
    await this.#http.graphql<{ issueUpdate: { success: boolean } }>(
      `mutation($id: String!, $stateId: String!) {
        issueUpdate(id: $id, input: { stateId: $stateId }) { success }
      }`,
      { variables: { id: ticketId, stateId } },
    );
    return { stateId };
  }

  async createComment(ticketId: string, body: string): Promise<{ id: string }> {
    const data = await this.#http.graphql<{
      commentCreate: { comment: { id: string } };
    }>(
      `mutation($issueId: String!, $body: String!) {
        commentCreate(input: { issueId: $issueId, body: $body }) {
          comment { id }
        }
      }`,
      { variables: { issueId: ticketId, body } },
    );
    return { id: data.commentCreate.comment.id };
  }

  async addReaction(
    commentId: string,
    reaction: ReactionContent,
  ): Promise<{ id: string }> {
    const data = await this.#http.graphql<{
      reactionCreate: { reaction: { id: string } };
    }>(
      `mutation($commentId: String!, $emoji: String!) {
        reactionCreate(input: { commentId: $commentId, emoji: $emoji }) {
          reaction { id }
        }
      }`,
      { variables: { commentId, emoji: reaction } },
    );
    return { id: data.reactionCreate.reaction.id };
  }

  /** Surface the project the ticket belongs to, if any. */
  async getProject(projectIdOrUrl: string): Promise<Project> {
    const id = extractProjectId(projectIdOrUrl);
    const data = await this.#http.graphql<{
      project: {
        id: string;
        name: string;
        url: string;
        description: string | null;
      } | null;
    }>(
      `query($id: String!) {
        project(id: $id) { id name url description }
      }`,
      { variables: { id } },
    );
    if (data.project === null) {
      throw new LinearError(`Linear project not found: ${id}`, {
        kind: "not-found",
      });
    }
    return data.project;
  }

  // -- internal helpers --

  async #findStateForRole(
    teamId: string,
    role: Role,
    teamKey: string,
  ): Promise<string> {
    const data = await this.#http.graphql<{
      team: {
        states: { nodes: Array<{ id: string; name: string; type: string }> };
      } | null;
    }>(
      `query($id: String!) {
        team(id: $id) {
          states { nodes { id name type } }
        }
      }`,
      { variables: { id: teamId } },
    );
    if (data.team === null) {
      throw new LinearError(`Linear team not found: ${teamId}`, {
        kind: "not-found",
      });
    }
    for (const s of data.team.states.nodes) {
      const mapped = safeMap(
        { name: s.name, type: s.type as LinearStateType, id: s.id },
        teamKey,
        this.#mapping,
      );
      if (mapped?.role === role) return s.id;
    }
    throw new MappingError(
      `team ${teamKey} has no workflow state mapped to role ${role}`,
    );
  }

  #materialize(raw: RawTicket): Ticket {
    const role = safeMap(
      {
        name: raw.state.name,
        type: raw.state.type as LinearStateType,
        id: raw.state.id,
      },
      raw.team.key,
      this.#mapping,
    );
    return {
      id: raw.id,
      identifier: raw.identifier,
      url: raw.url,
      title: raw.title,
      description: raw.description,
      assignee:
        raw.assignee === null
          ? null
          : {
              id: raw.assignee.id,
              name: raw.assignee.name,
              email: raw.assignee.email,
            },
      labels: raw.labels.nodes.map((l) => ({ id: l.id, name: l.name })),
      project:
        raw.project === null
          ? null
          : {
              id: raw.project.id,
              name: raw.project.name,
              url: raw.project.url,
            },
      team: { id: raw.team.id, key: raw.team.key, name: raw.team.name },
      state: { id: raw.state.id, name: raw.state.name, type: raw.state.type },
      role,
      parent:
        raw.parent === null
          ? null
          : { id: raw.parent.id, identifier: raw.parent.identifier },
      blockedBy: raw.relations.nodes
        .filter((r) => r.type === "blocks")
        .map((r) => ({
          id: r.relatedIssue.id,
          identifier: r.relatedIssue.identifier,
        })),
    };
  }
}

function safeMap(
  state: { id: string; name: string; type: LinearStateType },
  teamKey: string,
  mapping: MappingOptions,
): TicketRole | null {
  try {
    return mapLinearState({ state, teamKey }, mapping);
  } catch (err) {
    if (err instanceof MappingError) return null;
    throw err;
  }
}

function extractIdentifier(urlOrId: string): string {
  const trimmed = urlOrId.trim();
  if (IDENTIFIER_RE.test(trimmed)) return trimmed.toUpperCase();
  const m = trimmed.match(
    /linear\.app\/[^/]+\/issue\/([A-Za-z][A-Za-z0-9_]*-\d+)/,
  );
  if (m !== null && m[1] !== undefined) return m[1].toUpperCase();
  throw new Error(`unrecognized Linear ticket reference: ${urlOrId}`);
}

function extractProjectId(urlOrId: string): string {
  const trimmed = urlOrId.trim();
  // URLs look like https://linear.app/<org>/project/<slug>-<uuid>.
  const m = trimmed.match(
    /linear\.app\/[^/]+\/project\/[^/]*?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
  );
  if (m !== null && m[1] !== undefined) return m[1];
  return trimmed;
}

interface RawTicket {
  id: string;
  identifier: string;
  url: string;
  title: string;
  description: string | null;
  assignee: { id: string; name: string; email: string | null } | null;
  labels: { nodes: Array<{ id: string; name: string }> };
  project: { id: string; name: string; url: string } | null;
  team: { id: string; key: string; name: string };
  state: { id: string; name: string; type: string };
  parent: { id: string; identifier: string } | null;
  relations: {
    nodes: Array<{
      type: string;
      relatedIssue: { id: string; identifier: string };
    }>;
  };
}

const TICKET_FRAGMENT = `
  id
  identifier
  url
  title
  description
  assignee { id name email }
  labels { nodes { id name } }
  project { id name url }
  team { id key name }
  state { id name type }
  parent { id identifier }
  relations { nodes { type relatedIssue { id identifier } } }
`;

const TICKET_QUERY = `query($id: String!) { issue(id: $id) { ${TICKET_FRAGMENT} } }`;

const PROJECT_TICKETS_QUERY = `
  query($id: String!, $cursor: String) {
    project(id: $id) {
      issues(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { ${TICKET_FRAGMENT} }
      }
    }
  }
`;
