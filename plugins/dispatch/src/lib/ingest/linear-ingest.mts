import type {Database} from '../db/database.mts';
import {nowIso} from '../db/time.mts';
import {DataError, ensure} from '../errors/index.mts';
import type {
  LinearClient,
  LinearIssue,
  LinearMilestone,
  LinearProject,
  ReadOptions,
} from '../linear/index.mts';
import type {Status} from '../model/status.mts';
import {RefreshService} from '../refresh/index.mts';
import {
  EdgeStore,
  MilestoneStore,
  ProjectStore,
  TicketStore,
} from '../stores/index.mts';
import {statusOfLinearState} from './linear-status.mts';

/** The tracker id whose instructions this module answers. */
export const LINEAR_SOURCE = 'linear';

/** A refresh names projects by tracker id; a human may have typed a name. */
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu;

interface ScannedTicket {
  readonly issue: LinearIssue;
  readonly status: Status;
}

interface ScannedProject {
  readonly project: LinearProject;
  readonly milestones: readonly LinearMilestone[];
  readonly tickets: readonly ScannedTicket[];
}

interface Read {
  readonly client: LinearClient;
  readonly options: ReadOptions;
}

/** `exactOptionalPropertyTypes` refuses an explicit `undefined` signal. */
function readOptions(signal: AbortSignal | undefined): ReadOptions {
  return signal === undefined ? {} : {signal};
}

/** The project a `--project` entry names, by id or by exact name. */
async function resolveProject(
  selector: string,
  read: Read
): Promise<LinearProject> {
  const found = await read.client.listProjects(
    UUID.test(selector) ? {id: selector} : {name: selector},
    read.options
  );
  const project = found[0];
  ensure(
    project !== undefined,
    () =>
      new DataError(`linear has no project "${selector}"`, {
        hint: 'check the id passed to `dispatch refresh --project`, and that the api key can see that project.',
      })
  );
  ensure(
    found.length === 1,
    () =>
      new DataError(
        `"${selector}" names ${String(found.length)} linear projects`,
        {
          hint: "pass the project's tracker id rather than its name; names are not unique.",
        }
      )
  );
  return project;
}

/**
 * Everything one project's scan will write, fetched and mapped before any of it
 * is written. A state with no dispatch status has to fail the whole scan — the
 * build-graph agent then answers it instead — and failing after half the
 * project is written leaves the graph mid-scan for no reason.
 *
 * Milestones are read after the issues, not before: an issue can only name a
 * milestone that already existed when the issue was read, so reading them
 * second is what guarantees every `projectMilestone` is one of them.
 */
async function readProject(
  selector: string,
  cursor: string | null,
  read: Read
): Promise<ScannedProject> {
  const project = await resolveProject(selector, read);
  const issues = await read.client.listIssues(
    {project: project.id, updatedSince: cursor},
    read.options
  );
  const milestones = await read.client.listMilestones(project.id, read.options);
  return {
    project,
    milestones,
    tickets: issues.map((issue) => ({
      issue,
      status: statusOfLinearState(issue.state),
    })),
  };
}

/**
 * The ticket row itself, and nothing around it. Edges are the scan's business:
 * a ticket materialized to satisfy somebody else's dependency says nothing
 * about its own blockers or its milestone, and writing them from here would
 * chase the dependency graph out of the projects that were asked for.
 */
async function writeTicket(
  db: Database,
  project: string,
  {issue, status}: ScannedTicket
): Promise<void> {
  await new TicketStore(db).patchTicket({
    id: issue.identifier,
    project,
    status,
    title: issue.title,
    url: issue.url,
    // Linear's 0 is "no priority", which is a cleared priority rather than the
    // most urgent one; the graph spells that null.
    priority: issue.priority === 0 ? null : issue.priority,
    branchHint: issue.branchName === '' ? null : issue.branchName,
    labels: [...issue.labels],
    updatedAt: issue.updatedAt,
  });
}

async function writeProject(
  db: Database,
  scanned: ScannedProject
): Promise<void> {
  await new ProjectStore(db).upsertProject({
    id: scanned.project.id,
    name: scanned.project.name,
    source: LINEAR_SOURCE,
  });

  const milestones = new MilestoneStore(db);
  const edges = new EdgeStore(db);
  // Linear's own order is the delivery order: each milestone waits on the one
  // before it.
  let previous: LinearMilestone | undefined;
  for (const milestone of scanned.milestones) {
    await milestones.upsertMilestone({
      id: milestone.id,
      project: scanned.project.id,
      name: milestone.name,
    });
    if (previous !== undefined) await edges.addEdge(previous.id, milestone.id);
    previous = milestone;
  }

  for (const ticket of scanned.tickets) {
    await writeTicket(db, scanned.project.id, ticket);
    await edges.setMilestone(ticket.issue.identifier, ticket.issue.milestoneId);
    // The tracker's blockers are now exactly these. An id outside the scan
    // becomes a placeholder the refresh service asks for on its own.
    await edges.setEdges(
      ticket.issue.identifier,
      'blockers',
      ticket.issue.blockedBy
    );
  }
}

/**
 * Answer one `scan_project` instruction: read every named project from Linear,
 * write what it found, and report the scan complete.
 *
 * The cursor reported back is when this scan *started*, not the newest
 * `updatedAt` it saw. An issue edited while the scan was paging can land behind
 * a page already read, and a cursor drawn from the rows would step over that
 * edit forever.
 */
export async function ingestLinearScan(input: {
  readonly db: Database;
  readonly client: LinearClient;
  readonly projects: readonly string[];
  readonly cursor: string | null;
  readonly signal?: AbortSignal | undefined;
  readonly now?: () => string;
}): Promise<void> {
  const startedAt = (input.now ?? nowIso)();
  const read = {client: input.client, options: readOptions(input.signal)};
  const scanned: ScannedProject[] = [];
  for (const selector of input.projects) {
    scanned.push(await readProject(selector, input.cursor, read));
  }
  for (const project of scanned) {
    await writeProject(input.db, project);
  }
  await new RefreshService(input.db).completeScan({
    source: LINEAR_SOURCE,
    cursor: startedAt,
  });
}

/**
 * Answer one `fetch_ticket` or `refresh_ticket` instruction. A ticket Linear no
 * longer has is reported missing, which is what stops the graph asking for it
 * again.
 */
export async function ingestLinearTicket(input: {
  readonly db: Database;
  readonly client: LinearClient;
  readonly ticket: string;
  readonly signal?: AbortSignal | undefined;
}): Promise<void> {
  const refresh = new RefreshService(input.db);
  const read = {client: input.client, options: readOptions(input.signal)};
  const issue = await input.client.getIssue(input.ticket, read.options);
  if (issue === null) {
    await refresh.markMissing(input.ticket);
    return;
  }
  const projectId = issue.projectId;
  ensure(
    projectId !== null,
    () =>
      new DataError(`linear issue ${issue.identifier} is in no project`, {
        hint: 'put it in a project, or drop the dependency on it; every ticket in the graph is scoped to one.',
      })
  );
  // Usually a cross-project blocker, so the project may be one no scan has
  // covered; a ticket cannot be written until its project is recorded.
  const project = await resolveProject(projectId, read);
  await new ProjectStore(input.db).upsertProject({
    id: project.id,
    name: project.name,
    source: LINEAR_SOURCE,
  });
  await writeTicket(input.db, project.id, {
    issue,
    status: statusOfLinearState(issue.state),
  });
  await refresh.reconcile();
}
