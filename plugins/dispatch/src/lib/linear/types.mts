/** One page of a Linear connection, as every paged query returns it. */
export interface Page<TNode> {
  readonly nodes: readonly TNode[];
  readonly pageInfo: {
    readonly hasNextPage: boolean;
    readonly endCursor: string | null;
  };
}

export interface LinearProject {
  /** UUID. Tickets carry it as their project, so it is the graph's project id. */
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly updatedAt: string;
}

export interface LinearMilestone {
  readonly id: string;
  readonly name: string;
  /** Linear's ordering within the project; ascending. */
  readonly sortOrder: number;
}

export interface LinearIssue {
  /** UUID. `identifier` is what the graph and a human both use. */
  readonly id: string;
  /** Human identifier, e.g. `CLC-1159`. */
  readonly identifier: string;
  readonly title: string;
  readonly url: string;
  /** Workflow state as the team named it, with the group Linear files it under. */
  readonly state: {readonly name: string; readonly type: string};
  /** Linear's scale: 0 is "no priority", 1 urgent … 4 low. */
  readonly priority: number;
  readonly labels: readonly string[];
  readonly branchName: string;
  readonly updatedAt: string;
  readonly projectId: string | null;
  readonly milestoneId: string | null;
  /** Identifiers this issue blocks. */
  readonly blocks: readonly string[];
  /** Identifiers this issue waits on. */
  readonly blockedBy: readonly string[];
}
