import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {DataError} from '../errors/index.mts';
import {LinearClient} from './client.mts';
import type {ExecuteInput, GraphqlExecutor} from './transport.mts';

interface Call {
  query: string;
  variables: Record<string, unknown>;
}

/** An executor that answers from a script and records what it was asked. */
function scripted(responses: unknown[]): {
  execute: GraphqlExecutor;
  calls: Call[];
} {
  const calls: Call[] = [];
  let index = 0;
  const execute = (<TData,>(input: ExecuteInput): Promise<TData> => {
    calls.push({query: input.query, variables: input.variables ?? {}});
    const response = responses[index];
    index += 1;
    assert.ok(
      response !== undefined,
      'the client asked for more pages than the test scripted'
    );
    return Promise.resolve(response as TData);
  }) as GraphqlExecutor;
  return {execute, calls};
}

function issueNode(overrides: Record<string, unknown> = {}): unknown {
  return {
    id: 'uuid-1',
    identifier: 'CLC-1',
    title: 'Do the thing',
    url: 'https://linear.app/acme/issue/CLC-1',
    priority: 2,
    branchName: 'clc-1-do-the-thing',
    updatedAt: '2026-09-11T00:00:00.000Z',
    state: {name: 'In Progress', type: 'started'},
    project: {id: 'proj-1'},
    projectMilestone: {id: 'ms-1'},
    labels: {nodes: [{name: 'infra'}, {name: 'qa'}]},
    relations: {nodes: []},
    inverseRelations: {nodes: []},
    ...overrides,
  };
}

function connection(nodes: unknown[], next?: string): unknown {
  return {
    nodes,
    pageInfo: {hasNextPage: next !== undefined, endCursor: next ?? null},
  };
}

describe('LinearClient.listProjects', () => {
  it('follows the cursor to the end and concatenates the pages', async () => {
    const {execute, calls} = scripted([
      {
        projects: connection(
          [{id: 'p1', name: 'One', url: 'u1', updatedAt: 't1'}],
          'CUR'
        ),
      },
      {
        projects: connection([
          {id: 'p2', name: 'Two', url: 'u2', updatedAt: 't2'},
        ]),
      },
    ]);

    const projects = await new LinearClient(execute).listProjects();

    assert.deepEqual(
      projects.map((project) => project.id),
      ['p1', 'p2']
    );
    assert.equal(calls[0]?.variables.after, null);
    assert.equal(calls[1]?.variables.after, 'CUR');
  });

  it('refuses a connection that reports another page without advancing', async () => {
    const {execute} = scripted([
      {projects: connection([{id: 'p1', name: 'One'}], 'SAME')},
      {projects: connection([{id: 'p1', name: 'One'}], 'SAME')},
    ]);

    await assert.rejects(
      new LinearClient(execute).listProjects(),
      (error: unknown) =>
        error instanceof DataError &&
        error.message.includes('without advancing its cursor')
    );
  });
});

describe('LinearClient.listMilestones', () => {
  it('returns the project milestones in sortOrder', async () => {
    const {execute, calls} = scripted([
      {
        project: {
          projectMilestones: connection([
            {id: 'm2', name: 'Second', sortOrder: 2},
            {id: 'm1', name: 'First', sortOrder: 1},
          ]),
        },
      },
    ]);

    const milestones = await new LinearClient(execute).listMilestones('proj-1');

    assert.deepEqual(
      milestones.map((milestone) => milestone.id),
      ['m1', 'm2']
    );
    assert.equal(calls[0]?.variables.project, 'proj-1');
  });

  it('reads a project with no milestones as none, not as a failure', async () => {
    const {execute} = scripted([{project: {projectMilestones: null}}]);

    assert.deepEqual(await new LinearClient(execute).listMilestones('p'), []);
  });
});

describe('LinearClient.listIssues', () => {
  it('filters on the project alone when there is no cursor', async () => {
    const {execute, calls} = scripted([{issues: connection([issueNode()])}]);

    await new LinearClient(execute).listIssues({project: 'proj-1'});

    assert.deepEqual(calls[0]?.variables.filter, {
      project: {id: {eq: 'proj-1'}},
    });
  });

  it('asks only for what moved since the cursor', async () => {
    const {execute, calls} = scripted([{issues: connection([])}]);

    await new LinearClient(execute).listIssues({
      project: 'proj-1',
      updatedAfter: '2026-09-01T00:00:00.000Z',
    });

    assert.deepEqual(calls[0]?.variables.filter, {
      project: {id: {eq: 'proj-1'}},
      updatedAt: {gt: '2026-09-01T00:00:00.000Z'},
    });
  });

  it('leaves the filter unfiltered for an empty cursor', async () => {
    const {execute, calls} = scripted([{issues: connection([])}]);

    await new LinearClient(execute).listIssues({
      project: 'proj-1',
      updatedAfter: '',
    });

    assert.deepEqual(calls[0]?.variables.filter, {
      project: {id: {eq: 'proj-1'}},
    });
  });

  it('flattens the fields the graph records', async () => {
    const {execute} = scripted([{issues: connection([issueNode()])}]);

    const [issue] = await new LinearClient(execute).listIssues({
      project: 'proj-1',
    });

    assert.deepEqual(issue, {
      id: 'uuid-1',
      identifier: 'CLC-1',
      title: 'Do the thing',
      url: 'https://linear.app/acme/issue/CLC-1',
      state: {name: 'In Progress', type: 'started'},
      priority: 2,
      labels: ['infra', 'qa'],
      branchName: 'clc-1-do-the-thing',
      updatedAt: '2026-09-11T00:00:00.000Z',
      projectId: 'proj-1',
      milestoneId: 'ms-1',
      blocks: [],
      blockedBy: [],
    });
  });

  it('reads each end of a blocking relation as the direction it points', async () => {
    const {execute} = scripted([
      {
        issues: connection([
          issueNode({
            relations: {
              nodes: [
                {type: 'blocks', relatedIssue: {identifier: 'CLC-9'}},
                {type: 'related', relatedIssue: {identifier: 'CLC-8'}},
              ],
            },
            inverseRelations: {
              nodes: [
                {type: 'blocks', issue: {identifier: 'CLC-2'}},
                {type: 'duplicate', issue: {identifier: 'CLC-3'}},
              ],
            },
          }),
        ]),
      },
    ]);

    const [issue] = await new LinearClient(execute).listIssues({
      project: 'proj-1',
    });

    assert.ok(issue);
    assert.deepEqual(issue.blocks, ['CLC-9']);
    assert.deepEqual(issue.blockedBy, ['CLC-2']);
  });

  it('carries a ticket with no project or milestone as null, not as an empty id', async () => {
    const {execute} = scripted([
      {
        issues: connection([
          issueNode({project: null, projectMilestone: null, labels: null}),
        ]),
      },
    ]);

    const [issue] = await new LinearClient(execute).listIssues({
      project: 'proj-1',
    });

    assert.ok(issue);
    assert.equal(issue.projectId, null);
    assert.equal(issue.milestoneId, null);
    assert.deepEqual(issue.labels, []);
  });
});

describe('LinearClient.getIssue', () => {
  it('looks an identifier up by team key and number', async () => {
    const {execute, calls} = scripted([
      {issues: {nodes: [issueNode({identifier: 'CLC-1159'})]}},
    ]);

    const issue = await new LinearClient(execute).getIssue('clc-1159');

    assert.equal(issue?.identifier, 'CLC-1159');
    assert.deepEqual(calls[0]?.variables.filter, {
      team: {key: {eq: 'CLC'}},
      number: {eq: 1159},
    });
  });

  it('answers null for an issue the workspace does not have', async () => {
    const {execute} = scripted([{issues: {nodes: []}}]);

    assert.equal(await new LinearClient(execute).getIssue('CLC-9999'), null);
  });

  it('refuses something that is not an identifier before spending a call', async () => {
    const {execute, calls} = scripted([]);

    await assert.rejects(
      new LinearClient(execute).getIssue('https://linear.app/x/issue/CLC-1'),
      (error: unknown) => error instanceof DataError
    );
    assert.equal(calls.length, 0);
  });
});
