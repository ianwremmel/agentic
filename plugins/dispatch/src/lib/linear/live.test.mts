import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {createLinearClient} from './client.mts';
import type {LinearClient} from './client.mts';
import {readPage} from './paging.mts';
import type {RawPage} from './paging.mts';
import {
  ISSUE_INVERSE_RELATIONS_QUERY,
  ISSUE_LABELS_QUERY,
  ISSUE_RELATIONS_QUERY,
} from './queries/index.mts';
import {requireLinearToken} from './token.mts';
import {createTransport} from './transport.mts';
import type {GraphqlExecutor} from './transport.mts';
import type {LinearIssue} from './types.mts';

/**
 * The query documents are the one thing the mocked tests cannot check: a field
 * Linear removes ships green through every one of them. This runs them against
 * the real API.
 *
 * Opt-in — it needs network and a key, so CI and `npm test` skip it:
 *
 *     DISPATCH_LIVE_TESTS=1 npm test
 */
const enabled =
  process.env.DISPATCH_LIVE_TESTS === '1' &&
  (process.env.LINEAR_API_KEY ?? '') !== '';

const UUID = /^[0-9a-f-]{36}$/u;
const IDENTIFIER = /^[A-Za-z0-9]+-\d+$/u;

describe('linear live queries', {skip: !enabled}, () => {
  it('answers every query document the client sends', async () => {
    const client = createLinearClient(process.env);

    const projects = await client.listProjects();
    assert.ok(
      projects.length > 0,
      'the key can see no projects to test against'
    );
    const project = projects[0];
    assert.ok(project);
    // Shapes, not types. The client refuses an absent id outright, so what is
    // left to catch here is a selection that answers with the wrong thing.
    assert.match(project.id, UUID);

    const milestones = await findMilestones(client, projects);
    assert.ok(milestones, 'no project the key can see has any milestone');
    for (const milestone of milestones) {
      assert.match(milestone.id, UUID);
      // A sortOrder that arrives as a string or a NaN sorts nothing;
      // `Number.isFinite` refuses both.
      assert.ok(Number.isFinite(milestone.sortOrder));
    }

    const scanned = await scanProjects(client, projects);
    const first = scanned[0];
    assert.ok(first, 'no project the key can see has any issue');
    const [projectId, issues] = first;

    const issue = issues[0];
    assert.ok(issue);
    // The client refuses the identity fields when they are absent, so these
    // check what it cannot: that the selection answered with the right shape.
    // `url` and `branchName` still default to '', so those two also stand in
    // for the refusal the client does not make.
    assert.match(issue.identifier, IDENTIFIER);
    assert.match(issue.id, UUID);
    assert.match(issue.url, /^https:\/\/linear\.app\//u);
    assert.notEqual(issue.branchName, '');
    assert.match(issue.updatedAt, /^\d{4}-\d{2}-\d{2}T/u);
    assert.equal(typeof issue.priority, 'number');

    const everyIssue = scanned.flatMap(([, found]) => found);
    // `archivedAt` and `title` both default rather than being refused, so a
    // selection dropped from either reads as a live, untitled issue. An
    // archived issue coming back at all is also the only proof that
    // `includeArchived: true` is still on the query: without it Linear answers
    // with the unarchived rows and nothing looks wrong.
    assert.ok(
      everyIssue.some((found) => found.archivedAt !== null),
      'no issue the key can see is archived, so nothing checks that it is asked for'
    );
    for (const found of everyIssue) {
      assert.notEqual(
        found.title,
        '',
        `${found.identifier} came back untitled`
      );
    }

    const identifiers = await client.listIssueIdentifiers(projectId);
    assert.ok(identifiers.includes(issue.identifier));

    const fetched = await client.getIssue(issue.identifier);
    assert.equal(fetched?.identifier, issue.identifier);

    // The delta filter is inclusive, so the issue's own timestamp returns it.
    const delta = await client.listIssues({
      project: projectId,
      updatedSince: issue.updatedAt,
    });
    assert.ok(delta.some((found) => found.identifier === issue.identifier));

    // And it is applied at all: nothing was edited after this call started.
    const future = new Date(Date.now() + 86_400_000).toISOString();
    assert.deepEqual(
      await client.listIssues({project: projectId, updatedSince: future}),
      []
    );

    const execute = createTransport({token: requireLinearToken(process.env)});

    const [label] = await resume<{name?: unknown}>(
      execute,
      'labels',
      ISSUE_LABELS_QUERY,
      pick(everyIssue, (found) => found.labels.length > 0, 'a label')
    );
    assert.equal(typeof label?.name, 'string');

    const [relation] = await resume<RawRelation>(
      execute,
      'relations',
      ISSUE_RELATIONS_QUERY,
      pick(everyIssue, (found) => found.blocks.length > 0, 'an issue it blocks')
    );
    assert.equal(typeof relation?.type, 'string');
    assert.match(endOf(relation?.relatedIssue), IDENTIFIER);

    const [inverse] = await resume<RawRelation>(
      execute,
      'inverseRelations',
      ISSUE_INVERSE_RELATIONS_QUERY,
      pick(everyIssue, (found) => found.blockedBy.length > 0, 'a blocker')
    );
    assert.equal(typeof inverse?.type, 'string');
    assert.match(endOf(inverse?.issue), IDENTIFIER);
  });
});

/** Which of an issue's nested connections a resume document reads. */
type NestedField = 'inverseRelations' | 'labels' | 'relations';

interface RawRelation {
  type?: unknown;
  issue?: {identifier?: unknown} | null;
  relatedIssue?: {identifier?: unknown} | null;
}

/**
 * One page of a nested connection through its resume document, asked for a
 * single row so a connection holding more than one exercises the cursor.
 *
 * In production these documents go over the wire only when an issue overflows
 * its inline page of fifty, which most workspaces never have — so this is the
 * only place the real schema answers them.
 */
async function resume<TNode>(
  execute: GraphqlExecutor,
  field: NestedField,
  query: string,
  issue: LinearIssue
): Promise<readonly TNode[]> {
  const of = `${field} of ${issue.identifier}`;
  const data = await execute<{
    issue?: Partial<Record<NestedField, RawPage<TNode> | null>> | null;
  }>({query, variables: {after: null, first: 1, id: issue.id}});
  // `readPage` refuses a connection that came back without `nodes`, or without
  // a `pageInfo` saying whether more follow — what a dropped selection looks
  // like from here.
  const page = readPage(data.issue?.[field], of);
  assert.ok(page.nodes.length > 0, `${of} answered with no row to check`);
  // An absent `endCursor` is read as null rather than refused, so a document
  // that stopped selecting it surfaces only at run time, as a walk that ends
  // early and hands back a fraction of the connection as the whole of it.
  // Unconditional: Linear cursors the last row of a page whether or not more
  // pages follow, and this page has a row.
  assert.ok(page.pageInfo.endCursor, `${of} answered without a cursor`);
  return page.nodes;
}

/** The identifier at a relation's other end, or '' when the selection gave none. */
function endOf(end: {identifier?: unknown} | null | undefined): string {
  return typeof end?.identifier === 'string' ? end.identifier : '';
}

/**
 * An issue whose given connection is populated. An empty connection leaves
 * every one of its node fields unchecked, so failing here is the test saying it
 * could not do its job — not that Linear answered wrongly.
 */
function pick(
  issues: readonly LinearIssue[],
  has: (issue: LinearIssue) => boolean,
  what: string
): LinearIssue {
  const found = issues.find(has);
  assert.ok(found, `no issue the key can see has ${what} to resume`);
  return found;
}

/**
 * Issues of the first five projects the key can see, rather than the first
 * project with any. Labels and relations are each populated on some projects
 * and not others, and one project's issues would leave whichever it lacks
 * unchecked.
 */
async function scanProjects(
  client: LinearClient,
  projects: readonly {id: string}[]
): Promise<[string, LinearIssue[]][]> {
  const scanned: [string, LinearIssue[]][] = [];
  for (const project of projects.slice(0, 5)) {
    const issues = await client.listIssues({project: project.id});
    if (issues.length > 0) scanned.push([project.id, issues]);
  }
  return scanned;
}

/**
 * Milestones are optional on a project, so the first one need not have any —
 * and asserting over an empty list runs none of the assertions.
 */
async function findMilestones(
  client: LinearClient,
  projects: readonly {id: string}[]
): Promise<Awaited<ReturnType<typeof client.listMilestones>> | null> {
  for (const project of projects.slice(0, 5)) {
    const milestones = await client.listMilestones(project.id);
    if (milestones.length > 0) return milestones;
  }
  return null;
}
