/** Projects the key can see, narrowed by an optional filter. */
export const PROJECTS_QUERY = `query DispatchProjects($filter: ProjectFilter, $first: Int!, $after: String) {
  projects(filter: $filter, first: $first, after: $after, includeArchived: true) {
    nodes { id name }
    pageInfo { hasNextPage endCursor }
  }
}`;
