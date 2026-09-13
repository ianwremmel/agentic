import {DataError, EnvironmentError, ensure} from '../errors/index.mts';
import {requireField, requireKey} from './fields.mts';
import {NESTED_PAGE_SIZE, collectPages, readPage} from './paging.mts';
import type {RawPage} from './paging.mts';
import {
  ISSUE_INVERSE_RELATIONS_QUERY,
  ISSUE_LABELS_QUERY,
  ISSUE_RELATIONS_QUERY,
} from './queries/index.mts';
import type {GraphqlExecutor} from './transport.mts';
import type {LinearIssue} from './types.mts';

/**
 * Every scalar is nullable, because GraphQL says "this did not come back" with
 * `null` rather than by dropping the key. Typing them as merely optional is
 * what lets a `null` slip past a guard that only asks about `undefined`.
 */
interface RawRelation {
  type?: string | null;
  relatedIssue?: {identifier?: string | null} | null;
  issue?: {identifier?: string | null} | null;
}

interface RawLabel {
  name?: string | null;
}

export interface RawIssue {
  id?: string | null;
  identifier?: string | null;
  title?: string | null;
  url?: string | null;
  priority?: number | null;
  branchName?: string | null;
  updatedAt?: string | null;
  archivedAt?: string | null;
  state?: {name?: string | null; type?: string | null} | null;
  project?: {id?: string | null} | null;
  projectMilestone?: {id?: string | null} | null;
  labels?: RawPage<RawLabel> | null;
  relations?: RawPage<RawRelation> | null;
  inverseRelations?: RawPage<RawRelation> | null;
}

/** Which of an issue's nested connections a follow-up request is resuming. */
type NestedField = 'labels' | 'relations' | 'inverseRelations';

interface NestedConnection {
  readonly field: NestedField;
  readonly query: string;
}

const LABELS: NestedConnection = {field: 'labels', query: ISSUE_LABELS_QUERY};
const RELATIONS: NestedConnection = {
  field: 'relations',
  query: ISSUE_RELATIONS_QUERY,
};
const INVERSE_RELATIONS: NestedConnection = {
  field: 'inverseRelations',
  query: ISSUE_INVERSE_RELATIONS_QUERY,
};

interface NestedData<TNode> {
  issue?: Partial<Record<NestedField, RawPage<TNode> | null>> | null;
}

/** The executor plus the caller's cancellation, for reads an issue turns out to need. */
export interface Continuation {
  readonly execute: GraphqlExecutor;
  readonly signal: AbortSignal | undefined;
}

/**
 * All of one issue's nested connection, continuing past the inline page when
 * that page overflowed.
 *
 * Truncation here is silent data loss into a scheduling graph — half an issue's
 * blockers look exactly like all of them — so the overflow is finished with its
 * own request rather than dropped. Only the overflowing issue pays for it.
 */
async function readWholeConnection<TNode>(
  inline: RawPage<TNode> | null | undefined,
  connection: NestedConnection,
  issue: {readonly id: string; readonly identifier: string},
  more: Continuation
): Promise<readonly TNode[]> {
  const label = `${connection.field} of ${issue.identifier}`;
  const first = readPage(inline, label);
  if (!first.pageInfo.hasNextPage) return first.nodes;
  return collectPages<TNode>(async (after) => {
    const data = await more.execute<NestedData<TNode>>({
      query: connection.query,
      variables: {id: issue.id, first: NESTED_PAGE_SIZE, after},
      signal: more.signal,
    });
    const found = data.issue;
    ensure(
      found !== null && found !== undefined,
      () =>
        new DataError(
          `linear has no issue ${issue.identifier} to read the rest of its ${connection.field} from`,
          {
            hint: 'retry the scan; the issue was deleted or moved while it was being read.',
          }
        )
    );
    return readPage(found[connection.field], label);
  }, first);
}

/**
 * A blocking relation is one row Linear shows from both ends: the blocker
 * lists it under `relations`, the blocked issue under `inverseRelations`.
 * Which end we are reading is the only thing that says which direction it
 * points, so the direction is decided here and nowhere else.
 */
function readBlocking(
  nodes: readonly RawRelation[],
  side: 'relatedIssue' | 'issue',
  issue: string
): string[] {
  const found = nodes
    // The type is read before it is compared: dropped, every relation would
    // filter out and the issue would look like it has no blockers at all.
    .filter(
      (node) =>
        requireField(node.type, 'type', `a relation on ${issue}`) === 'blocks'
    )
    .map((node) => {
      const identifier = node[side]?.identifier ?? '';
      // Dropping this would record an issue as having fewer blockers than it
      // has, which is the one wrong answer a scheduler cannot detect.
      ensure(
        identifier !== '',
        () =>
          new EnvironmentError(
            `linear answered with a blocking relation on ${issue} without naming its other end`,
            {
              hint: 'retry the scan; a blocking edge cannot be recorded from one end alone.',
            }
          )
      );
      return identifier;
    });
  return [...new Set(found)].sort((a, b) => a.localeCompare(b));
}

/** One issue as Linear sent it, checked and turned into the shape callers read. */
export async function parseIssue(
  raw: RawIssue,
  more: Continuation
): Promise<LinearIssue> {
  // The identifier is how every caller names this ticket, the id is what
  // resumes an overflowing nested connection, the state decides whether the
  // ticket is schedulable, the priority orders the queue, and `updatedAt` is
  // the delta cursor and the milestone-review staleness input. None of them
  // has a safe default, so all of them are read before the nested walks —
  // paying for three of those and then refusing the issue is wasted work.
  const identifier = requireKey(raw.identifier, 'identifier', 'an issue');
  const state = {
    name: requireKey(raw.state?.name, 'state name', identifier),
    type: requireKey(raw.state?.type, 'state type', identifier),
  };
  const priority = requireField(raw.priority, 'priority', identifier);
  const updatedAt = requireKey(raw.updatedAt, 'updatedAt', identifier);
  const issue = {id: requireKey(raw.id, 'id', identifier), identifier};

  const labels = await readWholeConnection(raw.labels, LABELS, issue, more);
  const blocks = await readWholeConnection(
    raw.relations,
    RELATIONS,
    issue,
    more
  );
  const blockedBy = await readWholeConnection(
    raw.inverseRelations,
    INVERSE_RELATIONS,
    issue,
    more
  );
  return {
    id: issue.id,
    identifier,
    title: raw.title ?? '',
    url: raw.url ?? '',
    state,
    priority,
    labels: labels.map((node) =>
      requireField(node.name, 'name', `a label of ${identifier}`)
    ),
    branchName: raw.branchName ?? '',
    updatedAt,
    archivedAt: raw.archivedAt ?? null,
    // A null project or milestone is Linear saying the issue is in neither.
    // One that came back as an object without its id is a dropped selection,
    // and read as "no milestone" it would quietly shrink a milestone's
    // membership — the gate is computed over whoever is left.
    projectId: raw.project
      ? requireKey(raw.project.id, 'project id', identifier)
      : null,
    milestoneId: raw.projectMilestone
      ? requireKey(raw.projectMilestone.id, 'milestone id', identifier)
      : null,
    blocks: readBlocking(blocks, 'relatedIssue', identifier),
    blockedBy: readBlocking(blockedBy, 'issue', identifier),
  };
}
