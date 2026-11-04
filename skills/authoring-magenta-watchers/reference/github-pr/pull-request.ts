/**
 * GitHub pull request snapshot fetch (ETag-cached), normalization and
 * rendering. Ported from node/server/src/pull-requests/. Edit `render` and
 * `summarize` to filter checks or bot comments.
 */
import { type PollResult, regexScan } from "../../../../sdk/watchers/index.ts";
import type { GitHubClient, GitHubResponse } from "./github.ts";

/** Scoping knob: narrow the owner/repo part to restrict tracked PRs. */
export const scanPrUrls = regexScan([
  { pattern: /https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+/ },
]);

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

/** Per-path ETag plus the body it validates, so a 304 reuses the body. */
export type EtagCache = Record<string, { etag: string; body: unknown }>;
/** The poller's snapshot: carrying the ETag cache here keeps it per key and
 * lets the sdk drop it with the poller. It never reaches render output. */
export type PollState = { pr: PullRequestSnapshot; cache: EtagCache };

const PR_URL = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/;
const PER_PAGE = 100;

export function parsePullRequestUrl(url: string): PullRequestRef | undefined {
  const match = PR_URL.exec(url);
  if (!match) return undefined;
  const [, owner = "", repo = "", number = ""] = match;
  return { url, owner, repo, number: Number(number) };
}

export function isFinished(s: PollState): boolean {
  return (
    s.pr.state !== "open" && !s.pr.checks.some((c) => c.status === "pending")
  );
}

type FetchError = {
  type: "error";
  status: number | undefined;
  message: string;
};

export function makePoll(client: GitHubClient) {
  return async (
    key: string,
    ctx: { previous: PollState | undefined; signal: AbortSignal },
  ): Promise<PollResult<PollState>> => {
    const ref = parsePullRequestUrl(key);
    if (!ref) {
      return { kind: "unavailable", error: `Not a pull request URL: ${key}` };
    }
    const result = await fetchSnapshot(client, ref, ctx.previous?.cache ?? {});
    if (result.type === "ok") return { kind: "ok", snapshot: result.state };
    if (result.status === 404) {
      return { kind: "unavailable", error: result.message };
    }
    return { kind: "error", error: result.message };
  };
}

/** Bodies are committed to the cache only once every request succeeded, so a
 * failed poll leaves the previous snapshot and ETags in place. */
export async function fetchSnapshot(
  client: GitHubClient,
  ref: PullRequestRef,
  cache: EtagCache,
): Promise<{ type: "ok"; state: PollState } | FetchError> {
  const { owner, repo, number } = ref;
  const base = `repos/${owner}/${repo}`;
  const fetched: EtagCache = {};
  const get = async (
    path: string,
  ): Promise<{ type: "ok"; body: unknown } | FetchError> => {
    const cached = cache[path];
    const response: GitHubResponse = await client.get(path, cached?.etag);
    if (response.type === "error") return response;
    if (response.type === "not-modified") {
      if (!cached) {
        return {
          type: "error",
          status: 304,
          message: `304 without a cached body for ${path}`,
        };
      }
      fetched[path] = cached;
      return { type: "ok", body: cached.body };
    }
    // Without an ETag the body can never be revalidated, so don't cache it.
    if (response.etag !== undefined) {
      fetched[path] = { etag: response.etag, body: response.body };
    }
    return { type: "ok", body: response.body };
  };

  const pull = await get(`${base}/pulls/${number}`);
  if (pull.type !== "ok") return pull;
  const pr = asRecord(pull.body);
  const headSha = str(asRecord(pr.head).sha);
  const paths = [
    `${base}/commits/${headSha}/check-runs?per_page=${PER_PAGE}`,
    `${base}/commits/${headSha}/status`,
    `${base}/issues/${number}/comments?per_page=${PER_PAGE}`,
    `${base}/pulls/${number}/comments?per_page=${PER_PAGE}`,
    `${base}/pulls/${number}/reviews?per_page=${PER_PAGE}`,
  ];
  const bodies: unknown[] = [];
  for (const path of paths) {
    const result = await get(path);
    if (result.type !== "ok") return result;
    bodies.push(result.body);
  }
  const [checkRuns, combinedStatus, issueComments, reviewComments, reviews] =
    bodies;
  return {
    type: "ok",
    state: {
      cache: fetched,
      pr: normalizeSnapshot(ref, {
        pr,
        checkRuns,
        combinedStatus,
        issueComments,
        reviewComments,
        reviews,
      }),
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}
function optStr(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

export function checkRunStatus(
  status: string,
  conclusion: string | undefined,
): CheckStatus {
  if (status !== "completed") return "pending";
  switch (conclusion) {
    case "success":
      return "success";
    case "neutral":
      return "neutral";
    case "skipped":
    case "stale":
      return "skipped";
    default:
      return "failure";
  }
}
const REVIEW_STATES: ReadonlyArray<ReviewState> = [
  "APPROVED",
  "CHANGES_REQUESTED",
  "COMMENTED",
  "DISMISSED",
  "PENDING",
];
function reviewState(state: string): ReviewState | undefined {
  return REVIEW_STATES.find((s) => s === state);
}
function legacyStatus(state: string): CheckStatus {
  if (state === "success") return "success";
  if (state === "pending") return "pending";
  return "failure";
}

export function normalizeSnapshot(
  ref: PullRequestRef,
  raw: {
    pr: Record<string, unknown>;
    checkRuns: unknown;
    combinedStatus: unknown;
    issueComments: unknown;
    reviewComments: unknown;
    reviews: unknown;
  },
): PullRequestSnapshot {
  const { pr } = raw;
  const state: PullRequestSnapshot["state"] =
    pr.merged === true || optStr(pr.merged_at)
      ? "merged"
      : pr.state === "closed"
        ? "closed"
        : "open";
  const checkRunsBody = asRecord(raw.checkRuns);
  const runs = asArray(checkRunsBody.check_runs).map(asRecord);
  const statuses = asArray(asRecord(raw.combinedStatus).statuses).map(asRecord);
  const checks: PullRequestCheck[] = [
    ...runs.map((run) => ({
      name: str(run.name),
      status: checkRunStatus(str(run.status), optStr(run.conclusion)),
      url: optStr(run.html_url) ?? optStr(run.details_url),
    })),
    ...statuses.map((status) => ({
      name: str(status.context),
      status: legacyStatus(str(status.state)),
      url: optStr(status.target_url),
    })),
  ];
  const author = (item: Record<string, unknown>) =>
    str(asRecord(item.user).login);
  const issueComments = asArray(raw.issueComments).map(asRecord);
  const reviewComments = asArray(raw.reviewComments).map(asRecord);
  const reviews = asArray(raw.reviews).map(asRecord);
  const comments: PullRequestComment[] = [
    ...issueComments.map(
      (c): PullRequestComment => ({
        id: `issue:${String(c.id)}`,
        kind: "issue",
        author: author(c),
        body: str(c.body),
        url: str(c.html_url),
        updatedAt: str(c.updated_at),
      }),
    ),
    ...reviewComments.map((c): PullRequestComment => {
      const line = c.line ?? c.original_line;
      return {
        id: `review_comment:${String(c.id)}`,
        kind: "review_comment",
        author: author(c),
        body: str(c.body),
        url: str(c.html_url),
        updatedAt: str(c.updated_at),
        path: optStr(c.path),
        line: typeof line === "number" ? line : undefined,
      };
    }),
    ...reviews.map(
      (r): PullRequestComment => ({
        id: `review:${String(r.id)}`,
        kind: "review",
        author: author(r),
        body: str(r.body),
        url: str(r.html_url),
        updatedAt: str(r.submitted_at),
        reviewState: reviewState(str(r.state)),
      }),
    ),
  ];
  const totalRuns = checkRunsBody.total_count;
  const truncated =
    (typeof totalRuns === "number" && totalRuns > runs.length) ||
    [issueComments, reviewComments, reviews].some(
      (list) => list.length >= PER_PAGE,
    );
  return {
    ref,
    title: str(pr.title),
    state,
    draft: pr.draft === true,
    headSha: str(asRecord(pr.head).sha),
    checks,
    comments,
    truncated,
  };
}

function checkLine(check: PullRequestCheck): string {
  const url = check.url ? ` ${check.url}` : "";
  return `- ${check.name}: ${check.status}${url}`;
}

function commentText(comment: PullRequestComment): string {
  const where =
    comment.kind === "review_comment" && comment.path
      ? ` on ${comment.path}${comment.line !== undefined ? `:${comment.line}` : ""}`
      : "";
  const review =
    comment.kind === "review" && comment.reviewState
      ? ` (${comment.reviewState})`
      : "";
  const kind = comment.kind.replace("_", " ");
  return `### ${kind} by ${comment.author}${where}${review} (updated ${comment.updatedAt})\n${comment.url}\n\n${comment.body}`;
}

function checkCounts(checks: PullRequestCheck[]): string {
  const counts = new Map<CheckStatus, number>();
  for (const c of checks) counts.set(c.status, (counts.get(c.status) ?? 0) + 1);
  return [...counts].map(([status, n]) => `${n} ${status}`).join(", ");
}

/** The agent-facing blob. Magenta line-diffs successive blobs, so keep one
 * fact per line and a stable order. */
export function render({ pr }: PollState): string {
  return [
    `## ${pr.ref.url}`,
    "",
    `- Title: ${pr.title}`,
    `- State: ${pr.state}${pr.draft ? " (draft)" : ""}`,
    `- Head: ${pr.headSha}`,
    `- Checks: ${pr.checks.length ? checkCounts(pr.checks) : "none"}`,
    ...(pr.truncated
      ? ["- Some lists were truncated to the first 100 entries."]
      : []),
    "",
    "Checks:",
    ...(pr.checks.length ? pr.checks.map(checkLine) : ["(none)"]),
    "",
    "Comments:",
    ...(pr.comments.length ? pr.comments.map(commentText) : ["(none)"]),
  ].join("\n");
}

export function summarize({ pr }: PollState): {
  summary: string;
  details?: string;
} {
  const checks = pr.checks.length ? `, checks: ${checkCounts(pr.checks)}` : "";
  const comments = pr.comments.length
    ? `, ${pr.comments.length} comment${pr.comments.length === 1 ? "" : "s"}`
    : "";
  const summary = `${pr.ref.owner}/${pr.ref.repo}#${pr.ref.number} ${pr.state}${pr.draft ? " (draft)" : ""}: ${pr.title}${checks}${comments}`;
  if (!pr.checks.length) return { summary };
  return { summary, details: pr.checks.map(checkLine).join("\n") };
}
