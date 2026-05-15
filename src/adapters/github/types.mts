export interface RepoRef {
  owner: string;
  repo: string;
}

export type AccountType = "User" | "Bot" | "Organization" | "Mannequin";

export interface ViewerInfo {
  login: string;
  accountType: AccountType;
  id: string;
}

export interface PullRequest {
  number: number;
  nodeId: string;
  title: string;
  body: string | null;
  state: "OPEN" | "CLOSED" | "MERGED";
  isDraft: boolean;
  baseRef: string;
  headRef: string;
  headSha: string;
  author: { login: string; accountType: AccountType } | null;
  url: string;
}

export interface IssueComment {
  id: number;
  nodeId: string;
  body: string;
  author: { login: string; accountType: AccountType } | null;
  createdAt: string;
  updatedAt: string;
  url: string;
}

export interface ReviewThreadComment {
  id: number;
  nodeId: string;
  body: string;
  author: { login: string; accountType: AccountType } | null;
  createdAt: string;
  url: string;
}

export interface ReviewThread {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  isCollapsed: boolean;
  path: string | null;
  line: number | null;
  comments: ReviewThreadComment[];
}

export type CheckConclusion =
  | "success"
  | "failure"
  | "neutral"
  | "cancelled"
  | "skipped"
  | "timed_out"
  | "action_required"
  | "stale"
  | "startup_failure"
  | null;

export type CheckStatus =
  | "queued"
  | "in_progress"
  | "completed"
  | "waiting"
  | "pending"
  | "requested";

export interface CheckRun {
  id: number;
  nodeId: string;
  name: string;
  status: CheckStatus;
  conclusion: CheckConclusion;
  detailsUrl: string | null;
}

export interface ChecksRollup {
  headSha: string;
  total: number;
  checkRuns: CheckRun[];
}

export type ReactionContent =
  | "+1"
  | "-1"
  | "laugh"
  | "confused"
  | "heart"
  | "hooray"
  | "rocket"
  | "eyes";

export interface Reaction {
  id: number;
  content: ReactionContent;
  user: { login: string } | null;
}
