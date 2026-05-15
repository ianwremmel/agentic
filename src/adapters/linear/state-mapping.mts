/**
 * Per-tracker default state mapping for Linear.
 *
 * Spec: docs/spec/02-protocols/03-ticket-workflow-protocol/02-normative.md
 *   §"Per-tracker default mappings → Linear"
 *
 * Mapping resolution order (per spec §"Tagging rule"):
 *   team override → workspace override → default mapping → error.
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

/** Linear's immutable top-level state groups. */
export type LinearStateType =
  | "backlog"
  | "unstarted"
  | "started"
  | "completed"
  | "canceled"
  | "triage";

export interface LinearWorkflowState {
  id: string;
  /** Human-visible substate name, e.g. "In Progress", "Done". */
  name: string;
  /** Linear's top-level group bucket. */
  type: LinearStateType;
}

/**
 * Default Linear → protocol mapping, keyed by lower-cased substate name.
 * See the spec table for §"Linear" defaults.
 */
const DEFAULT_BY_SUBSTATE: Record<string, TicketRole> = {
  backlog: { group: "backlog", role: "backlog" },
  todo: { group: "unstarted", role: "available" },
  "in progress": { group: "started", role: "in-progress" },
  "in review": { group: "started", role: "in-review" },
  finished: { group: "started", role: "finished" },
  delivered: { group: "started", role: "delivered" },
  done: { group: "completed", role: "verified" },
  canceled: { group: "canceled", role: "canceled" },
  cancelled: { group: "canceled", role: "canceled" },
  duplicate: { group: "canceled", role: "canceled" },
};

/**
 * Linear top-level group → protocol group. The spec guarantees these
 * are stable; teams that need `paused` / `awaiting-external` must add
 * custom substates inside Linear's `Backlog` group and supply a
 * team override.
 */
const TYPE_TO_GROUP: Record<LinearStateType, Group> = {
  backlog: "backlog",
  unstarted: "unstarted",
  started: "started",
  completed: "completed",
  canceled: "canceled",
  triage: "backlog",
};

export interface OverrideEntry {
  /** Case-insensitive substate name. */
  substate: string;
  group?: Group;
  role: Role;
}

export interface MappingOptions {
  /**
   * Optional team-scoped overrides, keyed by Linear team key (e.g. "DEV").
   * Looked up first.
   */
  teamOverrides?: Record<string, OverrideEntry[]>;
  /** Workspace-wide overrides — fall back to these before defaults. */
  workspaceOverrides?: OverrideEntry[];
}

export interface MapInput {
  state: LinearWorkflowState;
  /** Team key (e.g. "DEV") for team-scoped override lookups. */
  teamKey?: string;
}

export class MappingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MappingError";
  }
}

/**
 * Resolve a Linear workflow state to a protocol {group, role}.
 *
 * Throws `MappingError` if no override and no default applies.
 */
export function mapLinearState(
  input: MapInput,
  opts: MappingOptions = {},
): TicketRole {
  const subKey = input.state.name.trim().toLowerCase();
  if (input.teamKey !== undefined) {
    const teamHit = opts.teamOverrides?.[input.teamKey]?.find(
      (e) => e.substate.toLowerCase() === subKey,
    );
    if (teamHit !== undefined) {
      return finalize(teamHit, input.state.type);
    }
  }
  const wsHit = opts.workspaceOverrides?.find(
    (e) => e.substate.toLowerCase() === subKey,
  );
  if (wsHit !== undefined) {
    return finalize(wsHit, input.state.type);
  }
  const defaultHit = DEFAULT_BY_SUBSTATE[subKey];
  if (defaultHit !== undefined) {
    return defaultHit;
  }
  throw new MappingError(
    `no role mapping for Linear state ${JSON.stringify(input.state.name)} ` +
      `(type=${input.state.type}); add a default-or-team override`,
  );
}

function finalize(entry: OverrideEntry, type: LinearStateType): TicketRole {
  const group = entry.group ?? TYPE_TO_GROUP[type];
  return { group, role: entry.role };
}
