import type {
  GitHubClient,
  GitHubResponse,
} from "../capabilities/github-client.ts";
import type { Logger } from "../logger.ts";
import {
  type CheckStatus,
  type PullRequestCheck,
  type PullRequestComment,
  type PullRequestRef,
  type PullRequestSnapshot,
  parsePullRequestUrl,
} from "./types.ts";

export type PullRequestPollStatus =
  | { type: "loading" }
  | { type: "ok"; lastPolledAt: number; nextPollAt: number }
  | {
      type: "failing";
      consecutiveFailures: number;
      lastError: string;
      nextPollAt: number;
    }
  | { type: "unavailable"; message: string }
  | { type: "finished" };

export type PullRequestSubscriber = {
  onChange: () => void;
  /** ms epoch of the thread's last user attention; `now` while it runs. */
  getLastAttention: () => number;
};

export const DEFAULT_POLL_INTERVAL_MS = 30_000;
const MAX_FAILURE_BACKOFF_MS = 10 * 60_000;
const DORMANT_AFTER_MS = 5 * 60_000;
const FIRST_DORMANT_DELAY_MS = 60_000;
const MAX_DORMANT_DELAY_MS = 5 * 60_000;
const PER_PAGE = 100;

type Poller = {
  ref: PullRequestRef;
  subscribers: Set<PullRequestSubscriber>;
  snapshot: PullRequestSnapshot | undefined;
  status: PullRequestPollStatus;
  /** Per-path ETag plus the body it validates, so a 304 reuses the body. */
  cache: Map<string, { etag: string | undefined; body: unknown }>;
  timer: ReturnType<typeof setTimeout> | undefined;
  inFlight: boolean;
  stopped: boolean;
  lastSettledAt: number | undefined;
  failureDelayMs: number;
  /** Undefined while some subscriber is attended. */
  dormantDelayMs: number | undefined;
};

type PollResult =
  | { type: "ok"; snapshot: PullRequestSnapshot }
  | {
      type: "error";
      status: number | undefined;
      message: string;
      retryAfterMs: number | undefined;
    };

/** Session-owned: one poller per PR URL, shared by every subscribed thread.
 * It never touches thread state; subscribers read the cached snapshot. */
export class PullRequestMonitor {
  private pollers = new Map<string, Poller>();
  private intervalMs: number;
  private now: () => number;
  constructor(
    private deps: {
      client: GitHubClient;
      logger: Logger;
      intervalMs?: number;
      now?: () => number;
    },
  ) {
    this.intervalMs = deps.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.now = deps.now ?? Date.now;
  }

  subscribe(url: string, sub: PullRequestSubscriber): () => void {
    let poller = this.pollers.get(url);
    if (!poller) {
      const ref = parsePullRequestUrl(url);
      poller = {
        ref: ref ?? { url, owner: "", repo: "", number: 0 },
        subscribers: new Set(),
        snapshot: undefined,
        status: ref
          ? { type: "loading" }
          : { type: "unavailable", message: `Not a pull request URL: ${url}` },
        cache: new Map(),
        timer: undefined,
        inFlight: false,
        stopped: !ref,
        lastSettledAt: undefined,
        failureDelayMs: 0,
        dormantDelayMs: undefined,
      };
      this.pollers.set(url, poller);
      poller.subscribers.add(sub);
      if (ref) this.poll(poller);
    } else {
      poller.subscribers.add(sub);
    }
    const current = poller;
    return () => {
      current.subscribers.delete(sub);
      if (current.subscribers.size === 0) this.stop(current);
    };
  }

  /** A thread got user attention: dormant pollers return to the base interval,
   * polling right away if the last poll is older than that. */
  noteAttention(): void {
    for (const poller of this.pollers.values()) {
      if (poller.dormantDelayMs === undefined) continue;
      poller.dormantDelayMs = undefined;
      if (poller.stopped || poller.inFlight) continue;
      const delay = Math.max(this.intervalMs, poller.failureDelayMs);
      const dueAt = (poller.lastSettledAt ?? 0) + delay;
      this.schedule(poller, Math.max(0, dueAt - this.now()));
    }
  }

  getSnapshot(url: string): PullRequestSnapshot | undefined {
    return this.pollers.get(url)?.snapshot;
  }

  getStatus(url: string): PullRequestPollStatus {
    return this.pollers.get(url)?.status ?? { type: "loading" };
  }

  dispose(): void {
    for (const poller of [...this.pollers.values()]) this.stop(poller);
  }

  private stop(poller: Poller): void {
    poller.stopped = true;
    if (poller.timer) clearTimeout(poller.timer);
    poller.timer = undefined;
    if (this.pollers.get(poller.ref.url) === poller) {
      this.pollers.delete(poller.ref.url);
    }
  }

  private schedule(poller: Poller, delayMs: number): void {
    if (poller.timer) clearTimeout(poller.timer);
    poller.timer = setTimeout(() => {
      poller.timer = undefined;
      this.poll(poller);
    }, delayMs);
    if (poller.status.type === "ok" || poller.status.type === "failing") {
      poller.status = { ...poller.status, nextPollAt: this.now() + delayMs };
    }
  }

  private poll(poller: Poller): void {
    if (poller.stopped || poller.inFlight) return;
    poller.inFlight = true;
    this.fetchSnapshot(poller).then(
      (result) => this.settle(poller, result),
      (error: unknown) =>
        this.settle(poller, {
          type: "error",
          status: undefined,
          message: error instanceof Error ? error.message : String(error),
          retryAfterMs: undefined,
        }),
    );
  }

  private settle(poller: Poller, result: PollResult): void {
    poller.inFlight = false;
    if (poller.stopped) return;
    const now = this.now();
    poller.lastSettledAt = now;
    if (result.type === "error") {
      if (result.status === 404) {
        poller.status = { type: "unavailable", message: result.message };
        poller.stopped = true;
        this.notify(poller);
        return;
      }
      const failures =
        poller.status.type === "failing"
          ? poller.status.consecutiveFailures + 1
          : 1;
      poller.failureDelayMs = Math.max(
        Math.min(this.intervalMs * 2 ** failures, MAX_FAILURE_BACKOFF_MS),
        result.retryAfterMs ?? 0,
      );
      this.deps.logger.warn(
        `Polling ${poller.ref.url} failed (${failures}x): ${result.message}`,
      );
      poller.status = {
        type: "failing",
        consecutiveFailures: failures,
        lastError: result.message,
        nextPollAt: now,
      };
      this.notify(poller);
    } else {
      poller.failureDelayMs = 0;
      const changed =
        JSON.stringify(poller.snapshot) !== JSON.stringify(result.snapshot);
      const wasOk = poller.status.type === "ok";
      poller.snapshot = result.snapshot;
      const { state, checks } = result.snapshot;
      if (state !== "open" && !checks.some((c) => c.status === "pending")) {
        poller.status = { type: "finished" };
        poller.stopped = true;
        this.notify(poller);
        return;
      }
      poller.status = { type: "ok", lastPolledAt: now, nextPollAt: now };
      if (changed || !wasOk) this.notify(poller);
    }
    this.schedule(
      poller,
      Math.max(poller.failureDelayMs, this.idleDelay(poller)),
    );
  }

  private idleDelay(poller: Poller): number {
    let lastAttention = Number.NEGATIVE_INFINITY;
    for (const sub of poller.subscribers) {
      lastAttention = Math.max(lastAttention, sub.getLastAttention());
    }
    if (this.now() - lastAttention < DORMANT_AFTER_MS) {
      poller.dormantDelayMs = undefined;
      return this.intervalMs;
    }
    poller.dormantDelayMs =
      poller.dormantDelayMs === undefined
        ? FIRST_DORMANT_DELAY_MS
        : Math.min(poller.dormantDelayMs * 2, MAX_DORMANT_DELAY_MS);
    return poller.dormantDelayMs;
  }

  private notify(poller: Poller): void {
    for (const sub of [...poller.subscribers]) {
      try {
        sub.onChange();
      } catch (e) {
        this.deps.logger.error(e);
      }
    }
  }

  /** Bodies are committed to the cache only once every request succeeded, so a
   * failed poll leaves both snapshot and ETags untouched. */
  private async fetchSnapshot(poller: Poller): Promise<PollResult> {
    const { owner, repo, number } = poller.ref;
    const base = `repos/${owner}/${repo}`;
    const fetched = new Map<
      string,
      { etag: string | undefined; body: unknown }
    >();
    const get = async (
      path: string,
    ): Promise<
      { type: "ok"; body: unknown } | Extract<PollResult, { type: "error" }>
    > => {
      if (poller.stopped) {
        return {
          type: "error",
          status: undefined,
          message: "stopped",
          retryAfterMs: undefined,
        };
      }
      const cached = poller.cache.get(path);
      const response: GitHubResponse = await this.deps.client.get(
        path,
        cached?.etag,
      );
      if (response.type === "error") return response;
      if (response.type === "not-modified") {
        if (!cached) {
          return {
            type: "error",
            status: 304,
            message: `304 without a cached body for ${path}`,
            retryAfterMs: undefined,
          };
        }
        fetched.set(path, cached);
        return { type: "ok", body: cached.body };
      }
      fetched.set(path, { etag: response.etag, body: response.body });
      return { type: "ok", body: response.body };
    };

    const pull = await get(`${base}/pulls/${number}`);
    if (pull.type === "error") return pull;
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
      if (result.type === "error") return result;
      bodies.push(result.body);
    }
    if (poller.stopped) {
      return {
        type: "error",
        status: undefined,
        message: "stopped",
        retryAfterMs: undefined,
      };
    }
    poller.cache = fetched;
    const [checkRuns, combinedStatus, issueComments, reviewComments, reviews] =
      bodies;
    return {
      type: "ok",
      snapshot: normalizeSnapshot(poller.ref, {
        pr,
        checkRuns,
        combinedStatus,
        issueComments,
        reviewComments,
        reviews,
      }),
    };
  }
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
        ...(optStr(c.path) ? { path: str(c.path) } : {}),
        ...(typeof line === "number" ? { line } : {}),
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
        ...(optStr(r.state) ? { reviewState: str(r.state) } : {}),
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
