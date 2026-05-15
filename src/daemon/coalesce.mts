// Event coalescer per `docs/spec/03-cli/01-daemon/02-normative.md`
// §Coalescing.
//
//   1 base event           → that event's kind (passthrough)
//   2+ PR-side             → `pr-coalesced`
//   2+ ticket-side         → `ticket-coalesced`
//   mixed PR + ticket      → `pr-coalesced`
//
// The coalesced payload MUST include every original base event
// verbatim — no lossy summarization. We satisfy this by storing the
// originals under `payload.originals` exactly as supplied.
//
// "Same polling tick" is the caller's concept; this module takes a
// batch of events for a single task as a single call. The polling
// loop / watch manager invokes `coalesce` once per tick.

import type { BaseEvent, DispatchEvent, EventKind } from "../state/event.mts";

/** Kinds classified as "PR-side" for coalescing. */
export const PR_SIDE_KINDS: ReadonlySet<EventKind> = new Set<EventKind>([
  "pr-comment",
  "pr-review",
  "pr-state-change",
  "ci-finished",
]);

/** Kinds classified as "ticket-side" for coalescing. */
export const TICKET_SIDE_KINDS: ReadonlySet<EventKind> = new Set<EventKind>([
  "ticket-comment",
  "ticket-state",
]);

export type CoalesceSide = "pr" | "ticket" | "other";

export function sideOf(kind: EventKind): CoalesceSide {
  if (PR_SIDE_KINDS.has(kind)) return "pr";
  if (TICKET_SIDE_KINDS.has(kind)) return "ticket";
  return "other";
}

/**
 * Coalesce a batch of events for a single task observed within one
 * polling tick.
 *
 * The caller guarantees:
 *   - `events.length >= 1`
 *   - all events share the same `task_id`
 *
 * If only one base event is supplied, it is returned unchanged. With
 * 2+ events, a single synthetic `pr-coalesced` or `ticket-coalesced`
 * event is returned. Mixed batches always use `pr-coalesced` per spec.
 *
 * Non-base kinds (heartbeat, daemon-restart, runner-error,
 * pr-coalesced, ticket-coalesced) are excluded from `side` accounting
 * and pass through verbatim alongside any coalescing — see §Coalescing
 * which only speaks of "base events", i.e. those produced by the
 * outside world. We pass non-base kinds through untouched at the
 * head of the returned array.
 */
export function coalesce(events: ReadonlyArray<DispatchEvent>): DispatchEvent[] {
  if (events.length === 0) {
    throw new RangeError("coalesce: batch must be non-empty");
  }
  const taskId = events[0]!.task_id;
  for (const e of events) {
    if (e.task_id !== taskId) {
      throw new RangeError(
        `coalesce: events have mixed task_id: ${taskId} vs ${e.task_id}`,
      );
    }
  }

  const passthrough: DispatchEvent[] = [];
  const coalescable: DispatchEvent[] = [];
  for (const e of events) {
    if (sideOf(e.kind) === "other") {
      passthrough.push(e);
    } else {
      coalescable.push(e);
    }
  }

  if (coalescable.length === 0) return [...passthrough];
  if (coalescable.length === 1) return [...passthrough, coalescable[0]!];

  let hasPr = false;
  let hasTicket = false;
  for (const e of coalescable) {
    const s = sideOf(e.kind);
    if (s === "pr") hasPr = true;
    else if (s === "ticket") hasTicket = true;
  }
  const kind: EventKind = hasPr ? "pr-coalesced" : "ticket-coalesced";
  // Sanity: 2+ items must have been at least one side.
  if (!hasPr && !hasTicket) {
    throw new Error("coalesce: invariant — coalescable items had no side");
  }

  // Newest timestamp wins, so consumers can sort the spool in
  // emission order without surprises.
  const newest = coalescable.reduce((acc, e) =>
    e.timestamp > acc.timestamp ? e : acc,
  );

  const synth: BaseEvent = {
    kind,
    task_id: taskId,
    timestamp: newest.timestamp,
    payload: {
      originals: coalescable.map((e) => ({ ...e })),
    },
  };

  return [...passthrough, synth];
}
