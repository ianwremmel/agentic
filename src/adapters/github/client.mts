import { resolveGitHubToken, type AuthOptions } from "./auth.mts";
import { GitHubHttpClient, type HttpClientOptions } from "./http.mts";
import type {
  AccountType,
  ChecksRollup,
  CheckRun,
  IssueComment,
  PullRequest,
  ReactionContent,
  RepoRef,
  ReviewThread,
  ReviewThreadComment,
  ViewerInfo,
} from "./types.mts";

export type ClientOptions = AuthOptions &
  Omit<HttpClientOptions, "token"> & {
    /** Override token resolution entirely (skips env + gh auth). */
    token?: string | (() => Promise<string>);
  };

/**
 * Thin typed wrapper around the GitHub API used by every PR-touching
 * dispatch command.
 */
export class GitHubAdapter {
  readonly #http: GitHubHttpClient;

  constructor(opts: ClientOptions = {}) {
    const tokenFn =
      typeof opts.token === "function"
        ? opts.token
        : typeof opts.token === "string"
          ? async () => opts.token as string
          : (() => {
              let cached: Promise<string> | undefined;
              return () => {
                cached ??= resolveGitHubToken({
                  env: opts.env,
                  ghAuthToken: opts.ghAuthToken,
                });
                return cached;
              };
            })();
    this.#http = new GitHubHttpClient({ ...opts, token: tokenFn });
  }

  /** Identity of the authenticated principal. */
  async whoAmI(): Promise<ViewerInfo> {
    const data = await this.#http.graphql<{
      viewer: { login: string; id: string; __typename: string };
    }>(`query { viewer { login id __typename } }`);
    return {
      login: data.viewer.login,
      id: data.viewer.id,
      accountType: normalizeAccountType(data.viewer.__typename),
    };
  }

  async getPr(ref: RepoRef, number: number): Promise<PullRequest> {
    const data = await this.#http.rest<RestPullRequest>(
      "GET",
      `/repos/${ref.owner}/${ref.repo}/pulls/${number}`,
    );
    return restToPullRequest(data);
  }

  async listPrComments(ref: RepoRef, number: number): Promise<IssueComment[]> {
    const items = await this.#paginate<RestIssueComment>(
      `/repos/${ref.owner}/${ref.repo}/issues/${number}/comments`,
    );
    return items.map(restToIssueComment);
  }

  async listPrReviewThreads(
    ref: RepoRef,
    number: number,
  ): Promise<ReviewThread[]> {
    const threads: ReviewThread[] = [];
    let cursor: string | null = null;
    for (;;) {
      const data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              pageInfo: { hasNextPage: boolean; endCursor: string | null };
              nodes: Array<{
                id: string;
                isResolved: boolean;
                isOutdated: boolean;
                isCollapsed: boolean;
                path: string | null;
                line: number | null;
                comments: {
                  nodes: Array<{
                    databaseId: number;
                    id: string;
                    body: string;
                    createdAt: string;
                    url: string;
                    author: { login: string; __typename: string } | null;
                  }>;
                };
              }>;
            };
          };
        };
      } = await this.#http.graphql(REVIEW_THREADS_QUERY, {
        variables: {
          owner: ref.owner,
          repo: ref.repo,
          number,
          cursor,
        },
      });
      for (const node of data.repository.pullRequest.reviewThreads.nodes) {
        threads.push({
          id: node.id,
          isResolved: node.isResolved,
          isOutdated: node.isOutdated,
          isCollapsed: node.isCollapsed,
          path: node.path,
          line: node.line,
          comments: node.comments.nodes.map(
            (c): ReviewThreadComment => ({
              id: c.databaseId,
              nodeId: c.id,
              body: c.body,
              createdAt: c.createdAt,
              url: c.url,
              author:
                c.author === null
                  ? null
                  : {
                      login: c.author.login,
                      accountType: normalizeAccountType(c.author.__typename),
                    },
            }),
          ),
        });
      }
      const page = data.repository.pullRequest.reviewThreads.pageInfo;
      if (!page.hasNextPage) break;
      cursor = page.endCursor;
    }
    return threads;
  }

  async getChecksRollup(
    ref: RepoRef,
    pullNumber: number,
  ): Promise<ChecksRollup> {
    const pr = await this.getPr(ref, pullNumber);
    const runs = await this.#paginate<RestCheckRun>(
      `/repos/${ref.owner}/${ref.repo}/commits/${pr.headSha}/check-runs`,
      "check_runs",
    );
    return {
      headSha: pr.headSha,
      total: runs.length,
      checkRuns: runs.map(restToCheckRun),
    };
  }

  async createIssueComment(
    ref: RepoRef,
    issueOrPr: number,
    body: string,
  ): Promise<{ id: number; nodeId: string }> {
    const created = await this.#http.rest<RestIssueComment>(
      "POST",
      `/repos/${ref.owner}/${ref.repo}/issues/${issueOrPr}/comments`,
      { body: { body } },
    );
    return { id: created.id, nodeId: created.node_id };
  }

  async replyToReviewThread(
    ref: RepoRef,
    threadId: string,
    body: string,
  ): Promise<{ nodeId: string }> {
    const data = await this.#http.graphql<{
      addPullRequestReviewThreadReply: {
        comment: { id: string };
      };
    }>(
      `mutation($threadId: ID!, $body: String!) {
        addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $threadId, body: $body }) {
          comment { id }
        }
      }`,
      { variables: { threadId, body } },
    );
    // Reference ref so eslint/no-unused-vars is happy and to keep
    // the signature consistent with other write methods.
    void ref;
    return { nodeId: data.addPullRequestReviewThreadReply.comment.id };
  }

  async addReaction(
    ref: RepoRef,
    commentId: number,
    reaction: ReactionContent,
  ): Promise<{ id: number }> {
    const created = await this.#http.rest<{ id: number }>(
      "POST",
      `/repos/${ref.owner}/${ref.repo}/issues/comments/${commentId}/reactions`,
      { body: { content: reaction } },
    );
    return { id: created.id };
  }

  async requestReview(
    ref: RepoRef,
    pr: number,
    reviewers: string[],
  ): Promise<{ nodeId: string }> {
    const data = await this.#http.rest<{ node_id: string }>(
      "POST",
      `/repos/${ref.owner}/${ref.repo}/pulls/${pr}/requested_reviewers`,
      { body: { reviewers } },
    );
    return { nodeId: data.node_id };
  }

  async #paginate<T>(path: string, listKey?: string): Promise<T[]> {
    const out: T[] = [];
    let url = `${path}${path.includes("?") ? "&" : "?"}per_page=100`;
    for (let i = 0; i < 50; i++) {
      const res = await this.#http.rest<unknown>("GET", url, {
        headers: { "x-paginate-mode": "manual" },
      });
      const items =
        listKey !== undefined && isObject(res) && Array.isArray(res[listKey])
          ? (res[listKey] as T[])
          : Array.isArray(res)
            ? (res as T[])
            : [];
      out.push(...items);
      if (items.length < 100) break;
      // GitHub uses Link headers we don't see through this wrapper;
      // fall back to page= parameter.
      const params = new URL(`https://api.github.com${url}`).searchParams;
      const next = Number(params.get("page") ?? "1") + 1;
      const u = new URL(`https://api.github.com${path}`);
      u.searchParams.set("per_page", "100");
      u.searchParams.set("page", String(next));
      url = `${u.pathname}${u.search}`;
    }
    return out;
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function normalizeAccountType(typename: string): AccountType {
  if (typename === "Bot") return "Bot";
  if (typename === "Organization") return "Organization";
  if (typename === "Mannequin") return "Mannequin";
  return "User";
}

interface RestPullRequest {
  number: number;
  node_id: string;
  title: string;
  body: string | null;
  state: "open" | "closed";
  merged: boolean;
  draft: boolean;
  base: { ref: string };
  head: { ref: string; sha: string };
  user: { login: string; type: string } | null;
  html_url: string;
}

function restToPullRequest(p: RestPullRequest): PullRequest {
  const state: PullRequest["state"] = p.merged
    ? "MERGED"
    : p.state === "open"
      ? "OPEN"
      : "CLOSED";
  return {
    number: p.number,
    nodeId: p.node_id,
    title: p.title,
    body: p.body,
    state,
    isDraft: p.draft,
    baseRef: p.base.ref,
    headRef: p.head.ref,
    headSha: p.head.sha,
    author:
      p.user === null
        ? null
        : {
            login: p.user.login,
            accountType: normalizeAccountType(p.user.type),
          },
    url: p.html_url,
  };
}

interface RestIssueComment {
  id: number;
  node_id: string;
  body: string;
  created_at: string;
  updated_at: string;
  html_url: string;
  user: { login: string; type: string } | null;
}

function restToIssueComment(c: RestIssueComment): IssueComment {
  return {
    id: c.id,
    nodeId: c.node_id,
    body: c.body,
    createdAt: c.created_at,
    updatedAt: c.updated_at,
    url: c.html_url,
    author:
      c.user === null
        ? null
        : {
            login: c.user.login,
            accountType: normalizeAccountType(c.user.type),
          },
  };
}

interface RestCheckRun {
  id: number;
  node_id: string;
  name: string;
  status: string;
  conclusion: string | null;
  details_url: string | null;
}

function restToCheckRun(r: RestCheckRun): CheckRun {
  return {
    id: r.id,
    nodeId: r.node_id,
    name: r.name,
    status: r.status as CheckRun["status"],
    conclusion: (r.conclusion as CheckRun["conclusion"]) ?? null,
    detailsUrl: r.details_url,
  };
}

const REVIEW_THREADS_QUERY = `
  query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        reviewThreads(first: 50, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            isResolved
            isOutdated
            isCollapsed
            path
            line
            comments(first: 50) {
              nodes {
                databaseId
                id
                body
                createdAt
                url
                author { login __typename }
              }
            }
          }
        }
      }
    }
  }
`;
