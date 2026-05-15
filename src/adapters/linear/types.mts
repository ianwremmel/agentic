import type { TicketRole } from "./state-mapping.mts";

export interface TicketRef {
  /** Stable Linear UUID. */
  id: string;
  /** Human-facing identifier (e.g. `DEV-123`). */
  identifier: string;
}

export interface Ticket extends TicketRef {
  url: string;
  title: string;
  description: string | null;
  assignee: { id: string; name: string; email: string | null } | null;
  labels: Array<{ id: string; name: string }>;
  project: { id: string; name: string; url: string } | null;
  team: { id: string; key: string; name: string };
  state: { id: string; name: string; type: string };
  /** Resolved {group, role} from the spec; null if no mapping applies. */
  role: TicketRole | null;
  parent: TicketRef | null;
  /** Ticket IDs that must reach `verified`/`canceled` before this one can start. */
  blockedBy: TicketRef[];
}

export interface Project {
  id: string;
  name: string;
  url: string;
  description: string | null;
}

export type ReactionContent =
  | "+1"
  | "-1"
  | "heart"
  | "rocket"
  | "tada"
  | "eyes";
