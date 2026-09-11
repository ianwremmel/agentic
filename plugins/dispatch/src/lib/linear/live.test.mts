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
    assert.equal(typeof project.id, 'string');
    assert.equal(typeof project.name, 'string');

    // Milestones are optional on a project; the query answering is the point.
    await client.listMilestones(project.id);

    const withIssues = await findProjectWithIssues(client, projects);
    assert.ok(withIssues, 'no project the key can see has any issue');
    const [projectId, issues] = withIssues;

    const issue = issues[0];
    assert.ok(issue);
    assert.match(issue.identifier, /^[A-Za-z0-9]+-\d+$/u);
    assert.equal(typeof issue.state.name, 'string');
    assert.equal(typeof issue.state.type, 'string');
    assert.equal(typeof issue.branchName, 'string');
    assert.equal(typeof issue.updatedAt, 'string');

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
