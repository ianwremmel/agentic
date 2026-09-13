import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {tempEnv} from '../command/test-support.mts';
import type {Database} from '../db/database.mts';
import {withDatabase} from '../db/index.mts';
import {DataError} from '../errors/index.mts';
import {LinearClient} from '../linear/index.mts';
import type {ExecuteInput, GraphqlExecutor} from '../linear/index.mts';
import {RefreshService} from '../refresh/index.mts';
import {
  CursorStore,
  EdgeStore,
  FetchRequestStore,
  MilestoneStore,
  ProjectStore,
  TicketStore,
} from '../stores/index.mts';
import {ingestLinearScan, ingestLinearTicket} from './linear-ingest.mts';

const PROJECT = '11111111-2222-3333-4444-555555555555';

interface Workspace {
  readonly projects?: unknown[];
  readonly milestones?: unknown[];
  readonly issues?: unknown[];
}

/**
 * An executor that answers by which query document it was handed, so a test
 * does not have to know the order the client reads in.
 */
function workspace(data: Workspace): GraphqlExecutor {
  const page = (nodes: unknown[]): unknown => ({
    nodes,
    pageInfo: {hasNextPage: false, endCursor: null},
  });
  return <TData,>(input: ExecuteInput): Promise<TData> => {
    const answer = input.query.includes('DispatchProjects(')
      ? {projects: page(data.projects ?? [])}
      : input.query.includes('DispatchMilestones(')
        ? {project: {projectMilestones: page(data.milestones ?? [])}}
        : input.query.includes('DispatchIssues(')
          ? {issues: page(data.issues ?? [])}
          : {issues: {nodes: data.issues ?? []}};
    return Promise.resolve(answer as TData);
  };
}

function issue(overrides: Record<string, unknown> = {}): unknown {
  return {
    id: 'uuid-1',
    identifier: 'CLC-1',
    title: 'Do the thing',
    url: 'https://linear.app/acme/issue/CLC-1',
    priority: 2,
    branchName: 'clc-1-do-the-thing',
    updatedAt: '2026-09-11T00:00:00.000Z',
    archivedAt: null,
    state: {name: 'Todo', type: 'unstarted'},
    project: {id: PROJECT},
    projectMilestone: null,
    labels: {nodes: [], pageInfo: {hasNextPage: false}},
    relations: {nodes: [], pageInfo: {hasNextPage: false}},
    inverseRelations: {nodes: [], pageInfo: {hasNextPage: false}},
    ...overrides,
  };
}

/** A refresh in `scanning`, which is the state a scan instruction is answered in. */
async function openScan(db: Database): Promise<void> {
  await new RefreshService(db).startScan({
    source: 'linear',
    projects: [PROJECT],
    sessionId: null,
    rebuild: false,
  });
}

async function scan(
  db: Database,
  data: Workspace,
  now = '2026-09-12T00:00:00.000Z'
) {
  await openScan(db);
  await ingestLinearScan({
    db,
    client: new LinearClient(workspace(data)),
    projects: [PROJECT],
    cursor: null,
    now: () => now,
  });
}

describe('ingestLinearScan', () => {
  it('writes the project, its milestones in Linear order, and each ticket', async () => {
    await withDatabase(undefined, await tempEnv(), async (db) => {
      await scan(db, {
        projects: [{id: PROJECT, name: 'Agentic'}],
        milestones: [
          {id: 'M2', name: 'Second', sortOrder: 2},
          {id: 'M1', name: 'First', sortOrder: 1},
        ],
        issues: [issue({projectMilestone: {id: 'M1'}})],
      });

      assert.deepEqual(await new ProjectStore(db).getProject(PROJECT), {
        id: PROJECT,
        name: 'Agentic',
        source: 'linear',
      });
      const ticket = await new TicketStore(db).getTicket('CLC-1');
      assert.ok(ticket);
      assert.equal(ticket.status, 'available');
      assert.equal(ticket.project, PROJECT);
      assert.equal(ticket.branchHint, 'clc-1-do-the-thing');
      assert.equal(ticket.updatedAt, '2026-09-11T00:00:00.000Z');

      const edges = await new EdgeStore(db).edges();
      // sortOrder, not the order Linear listed them in: M2 came back first.
      assert.ok(edges.some((e) => e.blocker === 'M1' && e.blocked === 'M2'));
      assert.ok(edges.some((e) => e.blocker === 'CLC-1' && e.blocked === 'M1'));
    });
  });

  it("records the scan's start as the cursor, not the newest updatedAt it read", async () => {
    await withDatabase(undefined, await tempEnv(), async (db) => {
      await scan(
        db,
        {
          projects: [{id: PROJECT, name: 'Agentic'}],
          issues: [issue()],
        },
        '2026-09-12T00:00:00.000Z'
      );
      // An issue edited mid-scan can land behind a page already read; a cursor
      // taken from the rows would step over that edit forever.
      assert.equal(
        await new CursorStore(db).getCursor('linear'),
        '2026-09-12T00:00:00.000Z'
      );
    });
  });

  it('declares a ticket’s blockers, leaving one outside the scan as a placeholder', async () => {
    await withDatabase(undefined, await tempEnv(), async (db) => {
      await scan(db, {
        projects: [{id: PROJECT, name: 'Agentic'}],
        issues: [
          issue({
            inverseRelations: {
              nodes: [{type: 'blocks', issue: {identifier: 'OPS-9'}}],
              pageInfo: {hasNextPage: false},
            },
          }),
        ],
      });
      const edges = await new EdgeStore(db).edges();
      assert.ok(
        edges.some((e) => e.blocker === 'OPS-9' && e.blocked === 'CLC-1')
      );
    });
  });

  it('moves a ticket out of its old milestone rather than leaving it in both', async () => {
    await withDatabase(undefined, await tempEnv(), async (db) => {
      const milestones = [
        {id: 'M1', name: 'First', sortOrder: 1},
        {id: 'M2', name: 'Second', sortOrder: 2},
      ];
      await scan(db, {
        projects: [{id: PROJECT, name: 'Agentic'}],
        milestones,
        issues: [issue({projectMilestone: {id: 'M1'}})],
      });
      await scan(db, {
        projects: [{id: PROJECT, name: 'Agentic'}],
        milestones,
        issues: [issue({projectMilestone: {id: 'M2'}})],
      });

      const membership = (await new EdgeStore(db).edges()).filter(
        (e) => e.blocker === 'CLC-1'
      );
      assert.deepEqual(membership, [{blocker: 'CLC-1', blocked: 'M2'}]);
    });
  });

  it('writes nothing when any ticket carries a state no table maps', async () => {
    await withDatabase(undefined, await tempEnv(), async (db) => {
      await openScan(db);
      await assert.rejects(
        ingestLinearScan({
          db,
          client: new LinearClient(
            workspace({
              projects: [{id: PROJECT, name: 'Agentic'}],
              issues: [
                issue(),
                issue({
                  id: 'uuid-2',
                  identifier: 'CLC-2',
                  state: {name: 'Needs QA', type: 'started'},
                }),
              ],
            })
          ),
          projects: [PROJECT],
          cursor: null,
        }),
        DataError
      );
      // The whole scan falls back to the agent, so the half that mapped cleanly
      // must not have been written.
      assert.equal(await new TicketStore(db).getTicket('CLC-1'), null);
      assert.equal(await new ProjectStore(db).getProject(PROJECT), null);
    });
  });

  it('refuses a project selector that names nothing', async () => {
    await withDatabase(undefined, await tempEnv(), async (db) => {
      await openScan(db);
      await assert.rejects(
        ingestLinearScan({
          db,
          client: new LinearClient(workspace({projects: []})),
          projects: [PROJECT],
          cursor: null,
        }),
        DataError
      );
    });
  });
});

describe('ingestLinearTicket', () => {
  it('records the ticket and the project it belongs to, which no scan may have covered', async () => {
    await withDatabase(undefined, await tempEnv(), async (db) => {
      await ingestLinearTicket({
        db,
        client: new LinearClient(
          workspace({
            projects: [{id: PROJECT, name: 'Agentic'}],
            issues: [issue({identifier: 'CLC-7'})],
          })
        ),
        ticket: 'CLC-7',
      });
      assert.equal(
        (await new TicketStore(db).getTicket('CLC-7'))?.project,
        PROJECT
      );
      assert.equal(
        (await new ProjectStore(db).getProject(PROJECT))?.source,
        'linear'
      );
    });
  });

  it('leaves milestone membership alone: a materialized dependency declares none', async () => {
    await withDatabase(undefined, await tempEnv(), async (db) => {
      await new ProjectStore(db).upsertProject({
        id: PROJECT,
        name: 'Agentic',
        source: 'linear',
      });
      await new MilestoneStore(db).upsertMilestone({
        id: 'M1',
        project: PROJECT,
        name: 'First',
      });
      await ingestLinearTicket({
        db,
        client: new LinearClient(
          workspace({
            projects: [{id: PROJECT, name: 'Agentic'}],
            issues: [
              issue({identifier: 'CLC-7', projectMilestone: {id: 'M1'}}),
            ],
          })
        ),
        ticket: 'CLC-7',
      });
      assert.deepEqual(await new EdgeStore(db).edges(), []);
    });
  });

  it('reports a ticket Linear no longer has as missing, closing the ask for good', async () => {
    await withDatabase(undefined, await tempEnv(), async (db) => {
      const requests = new FetchRequestStore(db);
      await requests.enqueueTicket({
        source: 'linear',
        ticket: 'CLC-404',
        at: '2026-09-12T00:00:00.000Z',
      });

      await ingestLinearTicket({
        db,
        client: new LinearClient(workspace({issues: []})),
        ticket: 'CLC-404',
      });

      assert.deepEqual(await requests.openTickets(), []);
    });
  });
});
