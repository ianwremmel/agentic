import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {createLinearClient} from './client.mts';

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
    assert.match(project.id, /^[0-9a-f-]{36}$/u);

    const milestones = await findMilestones(client, projects);
    assert.ok(milestones, 'no project the key can see has any milestone');
    for (const milestone of milestones) {
      assert.match(milestone.id, /^[0-9a-f-]{36}$/u);
      // `ordered` refuses a non-finite value but not a non-number, and a
      // sortOrder that arrives as a string sorts nothing.
      assert.ok(Number.isFinite(milestone.sortOrder));
      assert.equal(typeof milestone.sortOrder, 'number');
    }

    const withIssues = await findProjectWithIssues(client, projects);
    assert.ok(withIssues, 'no project the key can see has any issue');
    const [projectId, issues] = withIssues;

    const issue = issues[0];
    assert.ok(issue);
    // The client refuses the identity fields when they are absent, so these
    // check what it cannot: that the selection answered with the right shape.
    // `url` and `branchName` still default to '', so those two also stand in
    // for the refusal the client does not make.
    assert.match(issue.identifier, /^[A-Za-z0-9]+-\d+$/u);
    assert.match(issue.id, /^[0-9a-f-]{36}$/u);
    assert.match(issue.url, /^https:\/\/linear\.app\//u);
    assert.notEqual(issue.branchName, '');
    assert.match(issue.updatedAt, /^\d{4}-\d{2}-\d{2}T/u);
    assert.equal(typeof issue.priority, 'number');

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
  });
});

async function findProjectWithIssues(
  client: ReturnType<typeof createLinearClient>,
  projects: readonly {id: string}[]
): Promise<[string, Awaited<ReturnType<typeof client.listIssues>>] | null> {
  for (const project of projects.slice(0, 5)) {
    const issues = await client.listIssues({project: project.id});
    if (issues.length > 0) return [project.id, issues];
  }
  return null;
}

/**
 * Milestones are optional on a project, so the first one need not have any —
 * and asserting over an empty list runs none of the assertions.
 */
async function findMilestones(
  client: ReturnType<typeof createLinearClient>,
  projects: readonly {id: string}[]
): Promise<Awaited<ReturnType<typeof client.listMilestones>> | null> {
  for (const project of projects.slice(0, 5)) {
    const milestones = await client.listMilestones(project.id);
    if (milestones.length > 0) return milestones;
  }
  return null;
}
