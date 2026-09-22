import {DataError, ensure} from '../errors/index.mts';
import type {Status} from '../model/status.mts';

/**
 * Substates whose Linear group cannot decide their role. `started` holds
 * in-progress, in-review, finished and delivered at once, and `unstarted` holds
 * Todo alongside any custom Blocked a team adds, so both are read by name.
 */
const BY_NAME: ReadonlyMap<string, Status> = new Map<string, Status>([
  ['todo', 'available'],
  ['in progress', 'in-progress'],
  ['in review', 'in-review'],
  ['finished', 'finished'],
  ['delivered', 'delivered'],
]);

/**
 * Groups that mean one thing however the team named the substate — a completed
 * state is verified whether it reads Done, Shipped, or Merged. A team that
 * means `delivered` by "Merged" files it under `started`, where it lands in the
 * refusal below rather than here; `backlog` likewise absorbs a custom parked
 * substate, which is what the default role map already says a park looks like
 * until a team maps one.
 */
const BY_TYPE: ReadonlyMap<string, Status> = new Map<string, Status>([
  ['triage', 'backlog'],
  ['backlog', 'backlog'],
  ['completed', 'verified'],
  ['canceled', 'canceled'],
]);

/**
 * One Linear workflow state as a dispatch status.
 *
 * A state neither table covers is refused rather than guessed: a team's own
 * `Blocked` sits in `unstarted` beside Todo, and reading it as `available`
 * dispatches work that cannot start. The refusal is what hands the scan back to
 * the build-graph agent, which can ask about the state on the ticket.
 */
export function statusOfLinearState(state: {
  readonly name: string;
  readonly type: string;
}): Status {
  const byName = BY_NAME.get(state.name.trim().toLowerCase());
  if (byName !== undefined) return byName;
  const byType = BY_TYPE.get(state.type.trim().toLowerCase());
  ensure(
    byType !== undefined,
    () =>
      new DataError(
        `linear state "${state.name}" (${state.type}) has no dispatch status`,
        {
          hint: 'add it to the linear status tables in the dispatch CLI; until then unset LINEAR_API_KEY so the build-graph agent maps it.',
        }
      )
  );
  return byType;
}
