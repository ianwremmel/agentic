import { resolveAsanaPat, type AuthOptions } from "./auth.mts";
import { AsanaError } from "./errors.mts";
import { AsanaHttpClient, type HttpClientOptions } from "./http.mts";
import {
  mapAsanaState,
  MappingError,
  type MappingOptions,
  type Role,
  type TicketRole,
} from "./state-mapping.mts";
import type { Project, ReactionContent, Ticket, TicketRef } from "./types.mts";

export type AsanaAdapterOptions = AuthOptions &
  Omit<HttpClientOptions, "pat"> & {
    pat?: string | (() => Promise<string>);
    mapping?: MappingOptions;
  };

export interface TransitionOptions {
  /** Custom-field gid that holds the "Status" enum for this task's project. */
  statusFieldGid?: string;
  /** Custom-field option gid that maps to the target role. */
  statusOptionGid?: string;
}

const GID_RE = /^\d+$/;

/**
 * Asana adapter for the ticket-workflow protocol (§2.3).
 *
 * Asana exposes tasks via REST; the adapter normalizes them into the
 * common {@link Ticket} shape used by every tracker adapter.
 */
export class AsanaAdapter {
  readonly #http: AsanaHttpClient;
  readonly #mapping: MappingOptions;

  constructor(opts: AsanaAdapterOptions = {}) {
    const patFn =
      typeof opts.pat === "function"
        ? opts.pat
        : typeof opts.pat === "string"
          ? async () => opts.pat as string
          : (() => {
              let cached: Promise<string> | undefined;
              return () => {
                cached ??= resolveAsanaPat({
                  env: opts.env,
                  configLookup: opts.configLookup,
                });
                return cached;
              };
            })();
    this.#http = new AsanaHttpClient({ ...opts, pat: patFn });
    this.#mapping = opts.mapping ?? {};
  }

  /** Accept a task gid or a task URL; return the canonical gid pair. */
  async resolveTicket(urlOrId: string): Promise<TicketRef> {
    const gid = extractTaskGid(urlOrId);
    const data = await this.#http.request<{ gid: string }>(`tasks/${gid}`, {
      query: { opt_fields: "gid" },
    });
    return { id: data.gid, identifier: data.gid };
  }

  async getTicket(gid: string): Promise<Ticket> {
    const id = extractTaskGid(gid);
    const data = await this.#http.request<RawTask>(`tasks/${id}`, {
      query: { opt_fields: TASK_FIELDS },
    });
    return this.#materialize(data);
  }

  async listProjectTickets(projectGidOrUrl: string): Promise<Ticket[]> {
    const projectId = extractProjectGid(projectGidOrUrl);
    const out: Ticket[] = [];
    let offset: string | undefined;
    for (;;) {
      const data: RawTask[] = await this.#http.request(
        `projects/${projectId}/tasks`,
        {
          query: {
            opt_fields: TASK_FIELDS,
            limit: 100,
            offset,
          },
        },
      );
      for (const t of data) out.push(this.#materialize(t));
      // Asana pagination uses `next_page.offset` on the envelope; the
      // typed `request` helper unwraps `data`, so callers that need
      // pagination at this granularity should use the raw client.
      if (data.length < 100) break;
      const last = data[data.length - 1];
      if (last === undefined) break;
      offset = last.gid;
    }
    return out;
  }

  /**
   * Move a task to the workflow state that maps to the given protocol
   * role. The caller must supply the project's Status custom-field
   * GIDs unless the target role is `verified` (which sets the native
   * `completed` boolean).
   */
  async transitionTicket(
    taskId: string,
    targetRole: Role,
    opts: TransitionOptions = {},
  ): Promise<void> {
    if (targetRole === "verified") {
      await this.#http.request(`tasks/${taskId}`, {
        method: "PUT",
        body: { completed: true },
      });
      return;
    }
    if (
      opts.statusFieldGid === undefined ||
      opts.statusOptionGid === undefined
    ) {
      throw new MappingError(
        `transitioning to ${targetRole} requires statusFieldGid + statusOptionGid`,
      );
    }
    await this.#http.request(`tasks/${taskId}`, {
      method: "PUT",
      body: {
        completed: false,
        custom_fields: { [opts.statusFieldGid]: opts.statusOptionGid },
      },
    });
  }

  async createComment(taskId: string, body: string): Promise<{ id: string }> {
    const data = await this.#http.request<{ gid: string }>(
      `tasks/${taskId}/stories`,
      { method: "POST", body: { text: body } },
    );
    return { id: data.gid };
  }

  /**
   * Asana doesn't expose multi-emoji reactions; only `+1` (like) is
   * supported and is implemented by liking the story.
   */
  async addReaction(
    storyId: string,
    reaction: ReactionContent,
  ): Promise<{ id: string }> {
    if (reaction !== "+1" && reaction !== "heart") {
      throw new AsanaError(
        `asana only supports the "+1" (like) reaction; got ${reaction}`,
        { kind: "client-4xx" },
      );
    }
    await this.#http.request(`stories/${storyId}`, {
      method: "PUT",
      body: { liked: true },
    });
    return { id: storyId };
  }

  async getProject(projectGidOrUrl: string): Promise<Project> {
    const id = extractProjectGid(projectGidOrUrl);
    const data = await this.#http.request<{
      gid: string;
      name: string;
      permalink_url: string;
      notes: string | null;
    }>(`projects/${id}`, {
      query: { opt_fields: "gid,name,permalink_url,notes" },
    });
    return {
      id: data.gid,
      name: data.name,
      url: data.permalink_url,
      description: data.notes,
    };
  }

  // -- internal helpers --

  #materialize(raw: RawTask): Ticket {
    const project = raw.projects?.[0] ?? null;
    const statusOption = extractStatusOption(raw.custom_fields ?? []);
    const role = safeMap(
      { completed: raw.completed, statusOption },
      project?.gid,
      this.#mapping,
    );
    return {
      id: raw.gid,
      identifier: raw.gid,
      url: raw.permalink_url ?? `https://app.asana.com/0/0/${raw.gid}`,
      title: raw.name,
      description: raw.notes,
      assignee:
        raw.assignee === null || raw.assignee === undefined
          ? null
          : {
              id: raw.assignee.gid,
              name: raw.assignee.name,
              email: raw.assignee.email ?? null,
            },
      labels: (raw.tags ?? []).map((t) => ({ id: t.gid, name: t.name })),
      project:
        project === null
          ? null
          : {
              id: project.gid,
              name: project.name,
              url: project.permalink_url ?? "",
            },
      team: null,
      state: { completed: raw.completed, statusOption },
      role,
      parent:
        raw.parent === null || raw.parent === undefined
          ? null
          : { id: raw.parent.gid, identifier: raw.parent.gid },
      blockedBy: (raw.dependencies ?? []).map((d) => ({
        id: d.gid,
        identifier: d.gid,
      })),
    };
  }
}

function safeMap(
  state: { completed: boolean; statusOption: string | null },
  projectId: string | undefined,
  mapping: MappingOptions,
): TicketRole | null {
  try {
    return mapAsanaState({ state, projectId }, mapping);
  } catch (err) {
    if (err instanceof MappingError) return null;
    throw err;
  }
}

function extractStatusOption(
  fields: Array<{
    name?: string;
    resource_subtype?: string;
    enum_value?: { name: string } | null;
  }>,
): string | null {
  for (const f of fields) {
    if (
      f.resource_subtype === "enum" &&
      typeof f.name === "string" &&
      f.name.trim().toLowerCase() === "status" &&
      f.enum_value !== null &&
      f.enum_value !== undefined
    ) {
      return f.enum_value.name;
    }
  }
  return null;
}

function extractTaskGid(urlOrId: string): string {
  const trimmed = urlOrId.trim();
  if (GID_RE.test(trimmed)) return trimmed;
  // app.asana.com/0/<project>/<task>
  const a = trimmed.match(/app\.asana\.com\/0\/\d+\/(\d+)/);
  if (a !== null && a[1] !== undefined) return a[1];
  // app.asana.com/1/<ws>/project/<proj>/task/<task>
  const b = trimmed.match(/app\.asana\.com\/1\/\d+\/.+\/task\/(\d+)/);
  if (b !== null && b[1] !== undefined) return b[1];
  throw new Error(`unrecognized Asana task reference: ${urlOrId}`);
}

function extractProjectGid(urlOrId: string): string {
  const trimmed = urlOrId.trim();
  if (GID_RE.test(trimmed)) return trimmed;
  const a = trimmed.match(/app\.asana\.com\/0\/(\d+)/);
  if (a !== null && a[1] !== undefined) return a[1];
  const b = trimmed.match(/app\.asana\.com\/1\/\d+\/project\/(\d+)/);
  if (b !== null && b[1] !== undefined) return b[1];
  throw new Error(`unrecognized Asana project reference: ${urlOrId}`);
}

interface RawTask {
  gid: string;
  name: string;
  notes: string | null;
  completed: boolean;
  permalink_url?: string;
  assignee?: { gid: string; name: string; email?: string | null } | null;
  tags?: Array<{ gid: string; name: string }>;
  projects?: Array<{ gid: string; name: string; permalink_url?: string }>;
  parent?: { gid: string; name: string } | null;
  dependencies?: Array<{ gid: string }>;
  custom_fields?: Array<{
    gid: string;
    name?: string;
    resource_subtype?: string;
    enum_value?: { gid: string; name: string } | null;
  }>;
}

const TASK_FIELDS = [
  "gid",
  "name",
  "notes",
  "completed",
  "permalink_url",
  "assignee.gid",
  "assignee.name",
  "assignee.email",
  "tags.gid",
  "tags.name",
  "projects.gid",
  "projects.name",
  "projects.permalink_url",
  "parent.gid",
  "parent.name",
  "dependencies.gid",
  "custom_fields.gid",
  "custom_fields.name",
  "custom_fields.resource_subtype",
  "custom_fields.enum_value.gid",
  "custom_fields.enum_value.name",
].join(",");
