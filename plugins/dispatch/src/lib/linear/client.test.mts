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
    archivedAt: null,
    state: {name: 'In Progress', type: 'started'},
    project: {id: 'proj-1'},
    projectMilestone: {id: 'ms-1'},
    labels: {
      nodes: [{name: 'infra'}, {name: 'qa'}],
      pageInfo: {hasNextPage: false},
    },
    relations: {nodes: [], pageInfo: {hasNextPage: false}},
    inverseRelations: {nodes: [], pageInfo: {hasNextPage: false}},
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
      {projects: connection([{id: 'p1', name: 'One'}], 'CUR')},
      {projects: connection([{id: 'p2', name: 'Two'}])},
    ]);

    const projects = await new LinearClient(execute).listProjects();

    assert.deepEqual(projects, [
      {id: 'p1', name: 'One'},
      {id: 'p2', name: 'Two'},
    ]);
    assert.equal(calls[0]?.variables.after, null);
    assert.equal(calls[1]?.variables.after, 'CUR');
  });

  it('asks Linear to find a named project rather than reading the workspace', async () => {
    const {execute, calls} = scripted([{projects: connection([])}]);

    await new LinearClient(execute).listProjects({name: 'Agentic'});

    assert.deepEqual(calls[0]?.variables.filter, {name: {eq: 'Agentic'}});
  });

  it('sends no filter when nothing narrows the search', async () => {
    const {execute, calls} = scripted([{projects: connection([])}]);

    await new LinearClient(execute).listProjects();

    assert.equal(calls[0]?.variables.filter, null);
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

  it('refuses a connection that reports another page with no cursor at all', async () => {
    const {execute} = scripted([
      {projects: {nodes: [], pageInfo: {hasNextPage: true, endCursor: null}}},
    ]);

    await assert.rejects(
      new LinearClient(execute).listProjects(),
      (error: unknown) =>
        error instanceof DataError &&
        error.message.includes('no cursor to read it')
    );
  });

  it('stops rather than paging forever', async () => {
    const {execute, calls} = scripted(
      Array.from({length: 1001}, (_unused, index) => ({
        projects: connection(
          [{id: `p${String(index)}`, name: 'x'}],
          `c${String(index)}`
        ),
      }))
    );

    await assert.rejects(
      new LinearClient(execute).listProjects(),
      (error: unknown) =>
        error instanceof DataError && error.message.includes('still paging')
    );
    assert.equal(calls.length, 1000);
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

    assert.deepEqual(milestones, [
      {id: 'm1', name: 'First', sortOrder: 1},
      {id: 'm2', name: 'Second', sortOrder: 2},
    ]);
    assert.equal(calls[0]?.variables.project, 'proj-1');
  });

  it('keeps only the fields it declares', async () => {
    const {execute} = scripted([
      {
        project: {
          projectMilestones: connection([
            {id: 'm1', name: 'First', sortOrder: 1, secret: 'leaked'},
          ]),
        },
      },
    ]);

    const [milestone] = await new LinearClient(execute).listMilestones('p');

    assert.deepEqual(Object.keys(milestone ?? {}), ['id', 'name', 'sortOrder']);
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

  it('asks inclusively for what moved since the cursor, so a tie is re-read rather than lost', async () => {
    const {execute, calls} = scripted([{issues: connection([])}]);

    await new LinearClient(execute).listIssues({
      project: 'proj-1',
      updatedSince: '2026-09-01T00:00:00.000Z',
    });

    assert.deepEqual(calls[0]?.variables.filter, {
      project: {id: {eq: 'proj-1'}},
      updatedAt: {gte: '2026-09-01T00:00:00.000Z'},
    });
  });

  it('leaves the filter unfiltered for an empty cursor', async () => {
    const {execute, calls} = scripted([{issues: connection([])}]);

    await new LinearClient(execute).listIssues({
      project: 'proj-1',
      updatedSince: '',
    });

    assert.deepEqual(calls[0]?.variables.filter, {
      project: {id: {eq: 'proj-1'}},
    });
  });

  it('pages the delta to the end', async () => {
    const {execute, calls} = scripted([
      {issues: connection([issueNode({identifier: 'CLC-1'})], 'CUR')},
      {issues: connection([issueNode({identifier: 'CLC-2'})])},
    ]);

    const issues = await new LinearClient(execute).listIssues({
      project: 'proj-1',
    });

    assert.deepEqual(
      issues.map((issue) => issue.identifier),
      ['CLC-1', 'CLC-2']
    );
    assert.equal(calls[1]?.variables.after, 'CUR');
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
      archivedAt: null,
      projectId: 'proj-1',
      milestoneId: 'ms-1',
      blocks: [],
      blockedBy: [],
    });
  });

  it('carries an archived ticket through rather than dropping it', async () => {
    const {execute} = scripted([
      {
        issues: connection([
          issueNode({
            archivedAt: '2026-09-10T00:00:00.000Z',
            state: {name: 'Done', type: 'completed'},
          }),
        ]),
      },
    ]);

    const [issue] = await new LinearClient(execute).listIssues({
      project: 'proj-1',
    });

    assert.ok(issue);
    assert.equal(issue.archivedAt, '2026-09-10T00:00:00.000Z');
    assert.equal(issue.state.type, 'completed');
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
              pageInfo: {hasNextPage: false},
            },
            inverseRelations: {
              nodes: [
                {type: 'blocks', issue: {identifier: 'CLC-2'}},
                {type: 'duplicate', issue: {identifier: 'CLC-3'}},
              ],
              pageInfo: {hasNextPage: false},
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

  it('refuses an issue whose blockers it can only see half of', async () => {
    const {execute} = scripted([
      {
        issues: connection([
          issueNode({
            inverseRelations: {
              nodes: [{type: 'blocks', issue: {identifier: 'CLC-2'}}],
              pageInfo: {hasNextPage: true},
            },
          }),
        ]),
      },
    ]);

    await assert.rejects(
      new LinearClient(execute).listIssues({project: 'proj-1'}),
      (error: unknown) =>
        error instanceof DataError &&
        error.message.includes('CLC-1 has more than 50 inverse relations')
    );
  });

  it('carries a ticket with no project or milestone as null, not as an empty id', async () => {
    const {execute} = scripted([
      {
        issues: connection([
          issueNode({
            project: null,
            projectMilestone: null,
            labels: {nodes: [], pageInfo: {hasNextPage: false}},
          }),
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

describe('LinearClient.listIssueIdentifiers', () => {
  it('lists the whole project, undeltaed, so a caller can spot what left', async () => {
    const {execute, calls} = scripted([
      {issues: connection([{identifier: 'CLC-1'}, {identifier: 'CLC-2'}])},
    ]);

    const identifiers = await new LinearClient(execute).listIssueIdentifiers(
      'proj-1'
    );

    assert.deepEqual(identifiers, ['CLC-1', 'CLC-2']);
    assert.deepEqual(calls[0]?.variables.filter, {
      project: {id: {eq: 'proj-1'}},
    });
  });
});

describe('LinearClient.getIssue', () => {
  it('looks an identifier up by team key and number, whatever its case', async () => {
    const {execute, calls} = scripted([
      {issues: {nodes: [issueNode({identifier: 'CLC-1159'})]}},
    ]);

    const issue = await new LinearClient(execute).getIssue('clc-1159');

    assert.equal(issue?.identifier, 'CLC-1159');
    assert.deepEqual(calls[0]?.variables.filter, {
      team: {key: {eqIgnoreCase: 'clc'}},
      number: {eq: 1159},
    });
  });

  it('answers null for an issue the workspace does not have', async () => {
    const {execute} = scripted([{issues: {nodes: []}}]);

    assert.equal(await new LinearClient(execute).getIssue('CLC-9999'), null);
  });

  it('refuses an identifier Linear could not answer before spending a call', async () => {
    for (const bad of [
      'https://linear.app/x/issue/CLC-1',
      'CLC-007',
      'CLC-2147483648',
      'CLC-0',
      'CLC',
    ]) {
      const {execute, calls} = scripted([]);
      await assert.rejects(
        new LinearClient(execute).getIssue(bad),
        (error: unknown) => error instanceof DataError,
        `expected ${bad} to be refused`
      );
      assert.equal(calls.length, 0);
    }
  });
});
