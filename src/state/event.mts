/**
 * Event taxonomy from spec §Event taxonomy.
 *
 * Each event is persisted to the spool as one JSON file. The kind field is
 * the discriminator. The payload is opaque to the spool layer — schema for
 * each kind is enforced at the boundary where the event is produced (the
 * pollers, the runner-exit handler, the coalescer).
 */
export type EventKind =
  | "bootstrap"
  | "pr-comment"
  | "pr-review"
  | "ci-finished"
  | "pr-state-change"
  | "ticket-comment"
  | "ticket-state"
  | "heartbeat"
  | "daemon-restart"
  | "runner-error"
  | "pr-coalesced"
  | "ticket-coalesced";

export const EVENT_KINDS: readonly EventKind[] = [
  "bootstrap",
  "pr-comment",
  "pr-review",
  "ci-finished",
  "pr-state-change",
  "ticket-comment",
  "ticket-state",
  "heartbeat",
  "daemon-restart",
  "runner-error",
  "pr-coalesced",
  "ticket-coalesced",
] as const;

export interface BaseEvent<K extends EventKind = EventKind> {
  /** Stable kind discriminator. */
  kind: K;
  /** Canonical task ID this event targets. */
  task_id: string;
  /** RFC 3339 UTC timestamp (e.g. "2026-05-15T12:00:00.000Z"). */
  timestamp: string;
  /** Event-specific structured payload. */
  payload: Record<string, unknown>;
  /** Forward-compat: unknown fields survive read/write round-trips. */
  [extra: string]: unknown;
}

export type DispatchEvent = BaseEvent;

const RFC3339_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

export function isEventKind(value: unknown): value is EventKind {
  return (
    typeof value === "string" &&
    (EVENT_KINDS as readonly string[]).includes(value)
  );
}

export function isDispatchEvent(value: unknown): value is DispatchEvent {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (!isEventKind(v.kind)) return false;
  if (typeof v.task_id !== "string" || v.task_id.length === 0) return false;
  if (typeof v.timestamp !== "string" || !RFC3339_UTC.test(v.timestamp)) {
    return false;
  }
  if (typeof v.payload !== "object" || v.payload === null) return false;
  return true;
}

export function isRfc3339Utc(value: string): boolean {
  return RFC3339_UTC.test(value);
}
