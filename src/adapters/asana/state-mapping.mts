/**
 * Per-tracker default state mapping for Asana.
 *
 * Spec: docs/spec/02-protocols/03-ticket-workflow-protocol/02-normative.md
 *   §"Per-tracker default mappings → Asana"
 *
 * Asana represents state via a top-level `completed` boolean plus
 * an (optional) "Status" custom-field option. The default mapping
 * is:
 *
 *   Incomplete / Backlogged   → backlog/backlog
 *   Incomplete / Paused       → backlog/paused
 *   Incomplete / Blocked      → backlog/awaiting-external
 *   Incomplete / Committed    → unstarted/available
 *   Incomplete / In Progress  → started/in-progress
 *   Incomplete / In Review    → started/in-review
 *   Complete                  → completed/verified
 *
 * Mapping resolution order:
 *   project override → workspace override → default → MappingError.
 */

export type Group =
  | "backlog"
  | "unstarted"
  | "started"
  | "completed"
  | "canceled";

export type Role =
  | "backlog"
  | "paused"
  | "awaiting-external"
  | "available"
  | "in-progress"
  | "in-review"
  | "finished"
  | "delivered"
  | "verified"
  | "canceled";

export interface TicketRole {
  group: Group;
  role: Role;
}

export interface AsanaTaskState {
  completed: boolean;
  /**
   * The Status custom-field option (or section name) for incomplete
   * tasks. Spec-defined defaults include Backlogged, Paused, Blocked,
   * Committed, In Progress, In Review.
   */
  statusOption?: string | null;
}

/** Defaults are matched against the lower-cased status option. */
const DEFAULT_INCOMPLETE: Record<string, TicketRole> = {
  backlogged: { group: "backlog", role: "backlog" },
  paused: { group: "backlog", role: "paused" },
  blocked: { group: "backlog", role: "awaiting-external" },
  committed: { group: "unstarted", role: "available" },
  "in progress": { group: "started", role: "in-progress" },
  "in review": { group: "started", role: "in-review" },
};

export interface OverrideEntry {
  /** Case-insensitive status option / section name. */
  statusOption: string;
  group?: Group;
  role: Role;
}

export interface CompletedOverride {
  /** Override the role used when the task is `completed: true`. */
  group?: Group;
  role: Role;
}

export interface MappingOptions {
  /** Project-scoped overrides keyed by Asana project gid. */
  projectOverrides?: Record<string, OverrideEntry[]>;
  /** Workspace-wide overrides. */
  workspaceOverrides?: OverrideEntry[];
  /** Override the default `Complete → verified` mapping. */
  completedOverride?: CompletedOverride;
}

export interface MapInput {
  state: AsanaTaskState;
  /** Asana project gid for project-scoped override lookups. */
  projectId?: string;
}

export class MappingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MappingError";
  }
}

/**
 * Resolve an Asana task state to a protocol {group, role}.
 *
 * Throws `MappingError` if no override and no default applies.
 */
export function mapAsanaState(
  input: MapInput,
  opts: MappingOptions = {},
): TicketRole {
  if (input.state.completed) {
    const c = opts.completedOverride;
    if (c !== undefined) {
      return { group: c.group ?? "completed", role: c.role };
    }
    return { group: "completed", role: "verified" };
  }
  const status = input.state.statusOption?.trim().toLowerCase() ?? null;
  if (status === null || status.length === 0) {
    throw new MappingError(
      "no role mapping for incomplete Asana task without status option",
    );
  }
  if (input.projectId !== undefined) {
    const projHit = opts.projectOverrides?.[input.projectId]?.find(
      (e) => e.statusOption.toLowerCase() === status,
    );
    if (projHit !== undefined) return finalize(projHit);
  }
  const wsHit = opts.workspaceOverrides?.find(
    (e) => e.statusOption.toLowerCase() === status,
  );
  if (wsHit !== undefined) return finalize(wsHit);
  const defaultHit = DEFAULT_INCOMPLETE[status];
  if (defaultHit !== undefined) return defaultHit;
  throw new MappingError(
    `no role mapping for Asana status ${JSON.stringify(
      input.state.statusOption ?? "",
    )}`,
  );
}

function finalize(entry: OverrideEntry): TicketRole {
  return {
    group: entry.group ?? defaultGroupForRole(entry.role),
    role: entry.role,
  };
}

function defaultGroupForRole(role: Role): Group {
  switch (role) {
    case "backlog":
    case "paused":
    case "awaiting-external":
      return "backlog";
    case "available":
      return "unstarted";
    case "in-progress":
    case "in-review":
    case "finished":
    case "delivered":
      return "started";
    case "verified":
      return "completed";
    case "canceled":
      return "canceled";
  }
}
