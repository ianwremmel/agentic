/** One project's milestones. `project` is null when the key cannot see it. */
export const MILESTONES_QUERY = `query DispatchMilestones($project: String!, $first: Int!, $after: String) {
  project(id: $project) {
    projectMilestones(first: $first, after: $after, includeArchived: true) {
      nodes { id name sortOrder }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;
