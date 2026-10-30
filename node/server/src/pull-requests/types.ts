export type PullRequestRef = {
  url: string;
  owner: string;
  repo: string;
  number: number;
};
export type CheckStatus =
  | "pending"
  | "success"
  | "failure"
  | "neutral"
  | "skipped";
export type PullRequestCheck = {
  name: string;
  status: CheckStatus;
  url: string | undefined;
};
export type ReviewState =
  | "APPROVED"
  | "CHANGES_REQUESTED"
  | "COMMENTED"
  | "DISMISSED"
  | "PENDING";
type CommentBase = {
  author: string;
  body: string;
  url: string;
  updatedAt: string;
};
export type PullRequestComment =
  | (CommentBase & { kind: "issue"; id: `issue:${string}` })
  | (CommentBase & {
      kind: "review_comment";
      id: `review_comment:${string}`;
      path: string | undefined;
      line: number | undefined;
    })
  | (CommentBase & {
      kind: "review";
      id: `review:${string}`;
      reviewState: ReviewState | undefined;
    });
export type PullRequestSnapshot = {
  ref: PullRequestRef;
  title: string;
  state: "open" | "closed" | "merged";
  draft: boolean;
  headSha: string;
  checks: PullRequestCheck[];
  comments: PullRequestComment[];
  /** Some endpoint had more than one page of results; only the first is kept. */
  truncated: boolean;
};

const PR_URL = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/;
export function parsePullRequestUrl(url: string): PullRequestRef | undefined {
  const match = PR_URL.exec(url);
  if (!match) return undefined;
  const [, owner, repo, number] = match;
  return { url, owner, repo, number: Number(number) };
}
