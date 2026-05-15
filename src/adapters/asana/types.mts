import type { TicketRole } from "./state-mapping.mts";

export interface TicketRef {
  /** Asana task gid. */
  id: string;
  /** Asana's identifier == gid (no separate human-facing key). */
  identifier: string;
}

export interface Ticket extends TicketRef {
  url: string;
  title: string;
  description: string | null;
  assignee: { id: string; name: string; email: string | null } | null;
  labels: Array<{ id: string; name: string }>;
  project: { id: string; name: string; url: string } | null;
  /** Asana doesn't have teams; surfaced for shape parity. */
  team: { id: string; key: string; name: string } | null;
  state: { completed: boolean; statusOption: string | null };
  /** Resolved {group, role} from the spec; null if no mapping applies. */
  role: TicketRole | null;
  parent: TicketRef | null;
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
