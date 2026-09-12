import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {DataError, EnvironmentError} from '../errors/index.mts';
import {LinearClient} from './client.mts';
import type {ExecuteInput, GraphqlExecutor} from './transport.mts';

interface Call {
  query: string;
  variables: Record<string, unknown>;
  signal: AbortSignal | undefined;
}

/** An executor that answers from a script and records what it was asked. */
function scripted(responses: unknown[]): {
  execute: GraphqlExecutor;
  calls: Call[];
} {
  const calls: Call[] = [];
  let index = 0;
  const execute = (<TData,>(input: ExecuteInput): Promise<TData> => {
    calls.push({
      query: input.query,
      variables: input.variables ?? {},
      signal: input.signal,
    });
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
        error instanceof EnvironmentError &&
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
        error instanceof EnvironmentError &&
        error.message.includes('no cursor to read it')
    );
  });

  it('refuses an answer with no paging information rather than reading it as the last page', async () => {
    const {execute} = scripted([
      {projects: {nodes: [{id: 'p1', name: 'One'}]}},
    ]);

    await assert.rejects(
      new LinearClient(execute).listProjects(),
      (error: unknown) =>
        error instanceof EnvironmentError &&
        error.message.includes('without the projects')
    );
  });

  it('refuses an answer missing the connection entirely', async () => {
    const {execute} = scripted([{}]);

    await assert.rejects(
      new LinearClient(execute).listProjects(),
      (error: unknown) => error instanceof EnvironmentError
    );
  });

  // Defaulted to '', a project reaches the graph as an id nothing matches,
  // which reads exactly like a project with no work in it. GraphQL reports a
  // dropped field as null, so that shape has to fail too.
  it('refuses a project missing the id or name it was asked for', async () => {
    const cases: [unknown, string][] = [
      [{name: 'One'}, 'id of project One'],
      [{id: null, name: 'One'}, 'id of project One'],
      [{id: '', name: 'One'}, 'id of project One'],
      [{id: 'p1'}, 'name of project p1'],
      [{id: 'p1', name: null}, 'name of project p1'],
    ];

    for (const [node, expected] of cases) {
      const {execute} = scripted([{projects: connection([node])}]);

      await assert.rejects(
        new LinearClient(execute).listProjects(),
        (error: unknown) =>
          error instanceof EnvironmentError && error.message.includes(expected)
      );
    }
  });

  // A name is a display string, not something matched on, so an oddly named
  // row is still a real row — refusing it would fail the whole scan.
  it('keeps a project whose name is blank but present', async () => {
    const {execute} = scripted([
      {projects: connection([{id: 'p1', name: ''}])},
    ]);

    assert.deepEqual(await new LinearClient(execute).listProjects(), [
      {id: 'p1', name: ''},
    ]);
  });

  it('carries the caller cancellation into every page', async () => {
    const controller = new AbortController();
    const {execute, calls} = scripted([
      {projects: connection([{id: 'p1', name: 'One'}], 'CUR')},
      {projects: connection([{id: 'p2', name: 'Two'}])},
    ]);

    await new LinearClient(execute).listProjects(
      {},
      {signal: controller.signal}
    );

    assert.deepEqual(
      calls.map((call) => call.signal),
      [controller.signal, controller.signal]
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
    const {execute} = scripted([
      {project: {projectMilestones: connection([])}},
    ]);

    assert.deepEqual(await new LinearClient(execute).listMilestones('p'), []);
  });

  it('refuses a project linear does not have, rather than reading it as milestone-less', async () => {
    const {execute} = scripted([{project: null}]);

    await assert.rejects(
      new LinearClient(execute).listMilestones('nope'),
      (error: unknown) =>
        error instanceof DataError && error.message.includes('no project nope')
    );
  });

  // Defaulted, an unordered milestone sorts first, which is a different
  // milestone sequence rather than a missing field.
  it('refuses a milestone whose order did not come back', async () => {
    for (const sortOrder of [undefined, null]) {
      const {execute} = scripted([
        {
          project: {
            projectMilestones: connection([
              {id: 'm1', name: 'First', sortOrder},
            ]),
          },
        },
      ]);

      await assert.rejects(
        new LinearClient(execute).listMilestones('p'),
        (error: unknown) =>
          error instanceof EnvironmentError &&
          error.message.includes('sortOrder of milestone m1 of p')
      );
    }
  });

  it('refuses a milestone missing its id or name', async () => {
    const cases: [unknown, string][] = [
      [{name: 'First', sortOrder: 1}, 'id of milestone First of p'],
      [{id: null, name: 'First', sortOrder: 1}, 'id of milestone First of p'],
      [{id: 'm1', sortOrder: 1}, 'name of milestone m1 of p'],
      [{id: 'm1', name: null, sortOrder: 1}, 'name of milestone m1 of p'],
    ];

    for (const [node, expected] of cases) {
      const {execute} = scripted([
        {project: {projectMilestones: connection([node])}},
      ]);

      await assert.rejects(
        new LinearClient(execute).listMilestones('p'),
        (error: unknown) =>
          error instanceof EnvironmentError && error.message.includes(expected)
      );
    }
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

  // `DateTimeOrDuration` takes these, and parsing the cursor here before
  // sending it would refuse them — or, for a date that does not exist, roll it
  // over into one that does and scan from the wrong boundary.
  it('sends the cursor as written, duration and rollover alike', async () => {
    for (const cursor of ['-P2W1D', '2021', '2026-02-30T00:00:00.000Z']) {
      const {execute, calls} = scripted([{issues: connection([])}]);

      await new LinearClient(execute).listIssues({
        project: 'proj-1',
        updatedSince: cursor,
      });

      assert.deepEqual(calls[0]?.variables.filter, {
        project: {id: {eq: 'proj-1'}},
        updatedAt: {gte: cursor},
      });
    }
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

  it('finishes an issue whose blockers overflowed its inline page', async () => {
    const {execute, calls} = scripted([
      {
        issues: connection([
          issueNode({
            inverseRelations: {
              nodes: [{type: 'blocks', issue: {identifier: 'CLC-2'}}],
              pageInfo: {hasNextPage: true, endCursor: 'REL'},
            },
          }),
        ]),
      },
      {
        issue: {
          inverseRelations: connection(
            [{type: 'blocks', issue: {identifier: 'CLC-3'}}],
            'REL2'
          ),
        },
      },
      {
        issue: {
          inverseRelations: connection([
            {type: 'blocks', issue: {identifier: 'CLC-4'}},
          ]),
        },
      },
    ]);

    const [issue] = await new LinearClient(execute).listIssues({
      project: 'proj-1',
    });

    assert.ok(issue);
    assert.deepEqual(issue.blockedBy, ['CLC-2', 'CLC-3', 'CLC-4']);
    // Resumed by uuid, from the cursor the overflowing page ended on.
    const resumed = calls[1];
    const resumedAgain = calls[2];
    assert.ok(resumed);
    assert.ok(resumedAgain);
    assert.equal(resumed.variables.id, 'uuid-1');
    assert.equal(resumed.variables.after, 'REL');
    assert.equal(resumedAgain.variables.after, 'REL2');
  });

  // The id is what resumes an overflowing nested connection, so an issue
  // without one cannot be finished — and half an issue's blockers schedule
  // exactly like all of them.
  it('refuses an issue with no id, rather than recording half its blockers', async () => {
    for (const id of [undefined, null, '']) {
      const {execute} = scripted([{issues: connection([issueNode({id})])}]);

      await assert.rejects(
        new LinearClient(execute).listIssues({project: 'proj-1'}),
        (error: unknown) =>
          error instanceof EnvironmentError &&
          error.message.includes('id of CLC-1')
      );
    }
  });

  it('refuses an issue whose workflow state did not come back', async () => {
    const cases: [unknown, string][] = [
      [null, 'state name of CLC-1'],
      [{type: 'started'}, 'state name of CLC-1'],
      [{name: null, type: 'started'}, 'state name of CLC-1'],
      [{name: 'In Progress'}, 'state type of CLC-1'],
      [{name: 'In Progress', type: null}, 'state type of CLC-1'],
    ];

    for (const [state, expected] of cases) {
      const {execute} = scripted([{issues: connection([issueNode({state})])}]);

      await assert.rejects(
        new LinearClient(execute).listIssues({project: 'proj-1'}),
        (error: unknown) =>
          error instanceof EnvironmentError && error.message.includes(expected)
      );
    }
  });

  // Each of these orders or dates the ticket. A default is a wrong value, not
  // a blank one: priority 0 is Linear's "No priority", and an empty
  // `updatedAt` reads as NULL to the SQL that decides review staleness.
  it('refuses an issue missing the fields that rank or date it', async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{identifier: undefined}, 'identifier of an issue'],
      [{identifier: null}, 'identifier of an issue'],
      [{id: null}, 'id of CLC-1'],
      [{priority: undefined}, 'priority of CLC-1'],
      [{priority: null}, 'priority of CLC-1'],
      [{updatedAt: null}, 'updatedAt of CLC-1'],
      [{updatedAt: ''}, 'updatedAt of CLC-1'],
    ];

    for (const [overrides, expected] of cases) {
      const {execute} = scripted([
        {issues: connection([issueNode(overrides)])},
      ]);

      await assert.rejects(
        new LinearClient(execute).listIssues({project: 'proj-1'}),
        (error: unknown) =>
          error instanceof EnvironmentError && error.message.includes(expected)
      );
    }
  });

  // A null project is Linear saying the issue is in none. An object with no
  // id is a dropped selection, and read as "no milestone" it would quietly
  // shrink the milestone whose gate is computed over whoever is left.
  it('tells an issue in no milestone from one whose milestone id was dropped', async () => {
    const {execute} = scripted([
      {
        issues: connection([
          issueNode({project: null, projectMilestone: null}),
        ]),
      },
    ]);

    const [issue] = await new LinearClient(execute).listIssues({
      project: 'proj-1',
    });
    assert.ok(issue);
    assert.equal(issue.projectId, null);
    assert.equal(issue.milestoneId, null);

    const {execute: dropped} = scripted([
      {issues: connection([issueNode({projectMilestone: {}})])},
    ]);

    await assert.rejects(
      new LinearClient(dropped).listIssues({project: 'proj-1'}),
      (error: unknown) =>
        error instanceof EnvironmentError &&
        error.message.includes('milestone id of CLC-1')
    );
  });

  it('refuses a blocking relation linear did not name both ends of', async () => {
    const {execute} = scripted([
      {
        issues: connection([
          issueNode({
            inverseRelations: {
              nodes: [{type: 'blocks', issue: null}],
              pageInfo: {hasNextPage: false},
            },
          }),
        ]),
      },
    ]);

    await assert.rejects(
      new LinearClient(execute).listIssues({project: 'proj-1'}),
      (error: unknown) =>
        error instanceof EnvironmentError &&
        error.message.includes('without naming its other end')
    );
  });

  // The type decides which relations are blocking ones. Dropped, every
  // relation filters out and the issue looks like it has no blockers — the
  // one wrong answer a scheduler cannot detect.
  it('refuses a relation whose type did not come back', async () => {
    for (const type of [undefined, null]) {
      const {execute} = scripted([
        {
          issues: connection([
            issueNode({
              inverseRelations: {
                nodes: [{type, issue: {identifier: 'CLC-2'}}],
                pageInfo: {hasNextPage: false},
              },
            }),
          ]),
        },
      ]);

      await assert.rejects(
        new LinearClient(execute).listIssues({project: 'proj-1'}),
        (error: unknown) =>
          error instanceof EnvironmentError &&
          error.message.includes('type of a relation on CLC-1')
      );
    }
  });

  it('refuses a label whose name did not come back', async () => {
    const {execute} = scripted([
      {
        issues: connection([
          issueNode({
            labels: {
              nodes: [{name: 'infra'}, {name: null}],
              pageInfo: {hasNextPage: false},
            },
          }),
        ]),
      },
    ]);

    await assert.rejects(
      new LinearClient(execute).listIssues({project: 'proj-1'}),
      (error: unknown) =>
        error instanceof EnvironmentError &&
        error.message.includes('name of a label of CLC-1')
    );
  });

  it('refuses an issue whose relations came back without paging information', async () => {
    const {execute} = scripted([
      {issues: connection([issueNode({relations: null})])},
    ]);

    await assert.rejects(
      new LinearClient(execute).listIssues({project: 'proj-1'}),
      (error: unknown) =>
        error instanceof EnvironmentError &&
        error.message.includes('relations of CLC-1')
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

  // This list is what the caller reconciles membership against, so a dropped
  // identifier does not read as a broken answer — it reads as a ticket that
  // left the project, and the caller removes it from the graph with its edges.
  it('refuses a row with no identifier rather than shortening the list', async () => {
    for (const node of [{}, {identifier: null}, {identifier: ''}]) {
      const {execute} = scripted([
        {issues: connection([{identifier: 'CLC-1'}, node])},
      ]);

      await assert.rejects(
        new LinearClient(execute).listIssueIdentifiers('proj-1'),
        (error: unknown) =>
          error instanceof EnvironmentError &&
          error.message.includes('identifier of an issue of proj-1')
      );
    }
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

  it('accepts the largest issue number Linear can hold', async () => {
    const {execute, calls} = scripted([{issues: {nodes: []}}]);

    await new LinearClient(execute).getIssue('CLC-2147483647');

    assert.deepEqual(calls[0]?.variables.filter, {
      team: {key: {eqIgnoreCase: 'CLC'}},
      number: {eq: 2147483647},
    });
  });

  it('refuses an identifier Linear could not answer before spending a call', async () => {
    for (const bad of [
      'https://linear.app/x/issue/CLC-1',
      'CLC-007',
      'CLC-2147483648',
      'CLC-9999999999',
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
