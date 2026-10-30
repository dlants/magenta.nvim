import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitHubResponse } from "../capabilities/github-client.ts";
import { FakeGitHubClient } from "../test/fakes.ts";
import { noopLogger } from "../test-helpers.ts";
import { Defer } from "../utils/async.ts";
import { PullRequestMonitor } from "./monitor.ts";

const URL = "https://github.com/o/r/pull/12";
const BASE = "repos/o/r";
const PATHS = {
  pull: `${BASE}/pulls/12`,
  checkRuns: `${BASE}/commits/sha1/check-runs?per_page=100`,
  status: `${BASE}/commits/sha1/status`,
  issueComments: `${BASE}/issues/12/comments?per_page=100`,
  reviewComments: `${BASE}/pulls/12/comments?per_page=100`,
  reviews: `${BASE}/pulls/12/reviews?per_page=100`,
};
const ok = (body: unknown, etag = "e"): GitHubResponse => ({
  type: "ok",
  body,
  etag,
});
const MIN = 60_000;

function setup(
  opts: {
    state?: string;
    merged?: boolean;
    runs?: unknown[];
    totalRuns?: number;
  } = {},
) {
  const client = new FakeGitHubClient();
  const scriptPr = (pr: { state?: string; merged?: boolean } = {}) =>
    client.setResponse(
      PATHS.pull,
      ok({
        title: "T",
        state: pr.state ?? "open",
        merged: pr.merged ?? false,
        draft: false,
        head: { sha: "sha1" },
      }),
    );
  scriptPr(opts);
  client.setResponse(
    PATHS.checkRuns,
    ok({ total_count: opts.totalRuns ?? 0, check_runs: opts.runs ?? [] }),
  );
  client.setResponse(PATHS.status, ok({ statuses: [] }));
  client.setResponse(PATHS.issueComments, ok([]));
  client.setResponse(PATHS.reviewComments, ok([]));
  client.setResponse(PATHS.reviews, ok([]));
  const monitor = new PullRequestMonitor({ client, logger: noopLogger });
  const pullCalls = () =>
    client.calls.filter((c) => c.path === PATHS.pull).length;
  return { client, monitor, pullCalls, scriptPr };
}
const attended = () => ({
  onChange: vi.fn(),
  getLastAttention: () => Date.now(),
});

describe("PullRequestMonitor", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("shares one poller per URL and stops on last unsubscribe", async () => {
    const { monitor, pullCalls } = setup();
    const a = attended();
    const unsubA = monitor.subscribe(URL, a);
    const unsubB = monitor.subscribe(URL, attended());
    await vi.advanceTimersByTimeAsync(0);
    expect(pullCalls()).toBe(1);
    expect(a.onChange).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(pullCalls()).toBe(2);
    unsubA();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(pullCalls()).toBe(3);
    unsubB();
    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(pullCalls()).toBe(3);
  });

  it("dispose drops an in-flight poll", async () => {
    const { client, monitor } = setup();
    const pending = new Defer<GitHubResponse>();
    client.setResponse(PATHS.pull, () => pending.promise);
    const sub = attended();
    monitor.subscribe(URL, sub);
    monitor.dispose();
    pending.resolve(ok({ state: "open", head: { sha: "sha1" } }));
    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(sub.onChange).not.toHaveBeenCalled();
    expect(monitor.getSnapshot(URL)).toBeUndefined();
    expect(client.calls.length).toBe(1);
  });

  it("sends stored etags; 304s keep the snapshot without notifying", async () => {
    const { client, monitor } = setup();
    const sub = attended();
    monitor.subscribe(URL, sub);
    await vi.advanceTimersByTimeAsync(0);
    const snapshot = monitor.getSnapshot(URL);
    for (const path of Object.values(PATHS)) {
      client.setResponse(path, { type: "not-modified" });
    }
    client.calls = [];
    await vi.advanceTimersByTimeAsync(30_000);
    expect(client.calls).toHaveLength(6);
    expect(client.calls.every((c) => c.etag === "e")).toBe(true);
    expect(monitor.getSnapshot(URL)).toEqual(snapshot);
    expect(sub.onChange).toHaveBeenCalledTimes(1);
  });

  it("normalizes check runs, statuses and comments", async () => {
    const { client, monitor } = setup({
      totalRuns: 200,
      runs: [
        { name: "q", status: "queued", conclusion: null },
        { name: "p", status: "in_progress" },
        {
          name: "s",
          status: "completed",
          conclusion: "success",
          html_url: "u",
        },
        { name: "f", status: "completed", conclusion: "timed_out" },
        { name: "n", status: "completed", conclusion: "neutral" },
        { name: "k", status: "completed", conclusion: "skipped" },
      ],
    });
    client.setResponse(
      PATHS.status,
      ok({
        statuses: [
          { context: "e", state: "error", target_url: "t" },
          { context: "x", state: "failure" },
          { context: "y", state: "pending" },
        ],
      }),
    );
    client.setResponse(
      PATHS.reviewComments,
      ok([
        {
          id: 4,
          user: { login: "bot" },
          body: "b",
          html_url: "h",
          updated_at: "t1",
          path: "a.ts",
          line: 3,
        },
      ]),
    );
    client.setResponse(
      PATHS.reviews,
      ok([
        {
          id: 5,
          user: { login: "me" },
          body: "",
          state: "APPROVED",
          submitted_at: "t2",
          html_url: "h2",
        },
      ]),
    );
    monitor.subscribe(URL, attended());
    await vi.advanceTimersByTimeAsync(0);
    const snapshot = monitor.getSnapshot(URL);
    expect(
      snapshot?.checks.map((c) => `${c.name}:${c.status}:${c.url ?? ""}`),
    ).toEqual([
      "q:pending:",
      "p:pending:",
      "s:success:u",
      "f:failure:",
      "n:neutral:",
      "k:skipped:",
      "e:failure:t",
      "x:failure:",
      "y:pending:",
    ]);
    expect(snapshot?.truncated).toBe(true);
    expect(snapshot?.comments).toEqual([
      {
        id: "review_comment:4",
        kind: "review_comment",
        author: "bot",
        body: "b",
        url: "h",
        updatedAt: "t1",
        path: "a.ts",
        line: 3,
      },
      {
        id: "review:5",
        kind: "review",
        author: "me",
        body: "",
        url: "h2",
        updatedAt: "t2",
        reviewState: "APPROVED",
      },
    ]);
  });

  it("a failing endpoint keeps the snapshot and backs off; success resets", async () => {
    const { client, monitor, pullCalls } = setup();
    monitor.subscribe(URL, attended());
    await vi.advanceTimersByTimeAsync(0);
    const snapshot = monitor.getSnapshot(URL);
    client.setResponse(PATHS.issueComments, ok([{ id: 1, body: "new" }]));
    client.setResponse(PATHS.reviews, {
      type: "error",
      status: 502,
      message: "bad gateway",
      retryAfterMs: undefined,
    });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(monitor.getSnapshot(URL)).toBe(snapshot);
    expect(monitor.getStatus(URL)).toMatchObject({
      type: "failing",
      consecutiveFailures: 1,
      lastError: "bad gateway",
    });
    await vi.advanceTimersByTimeAsync(59_999);
    expect(pullCalls()).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(pullCalls()).toBe(3);
    expect(monitor.getStatus(URL)).toMatchObject({ consecutiveFailures: 2 });
    client.setResponse(PATHS.reviews, ok([]));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(pullCalls()).toBe(4);
    expect(monitor.getStatus(URL).type).toBe("ok");
    expect(monitor.getSnapshot(URL)?.comments).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(pullCalls()).toBe(5);
  });

  it("waits for rate-limit reset", async () => {
    const { client, monitor, pullCalls } = setup();
    client.setResponse(PATHS.pull, {
      type: "error",
      status: 403,
      message: "rate limited",
      retryAfterMs: 10 * MIN,
    });
    monitor.subscribe(URL, attended());
    await vi.advanceTimersByTimeAsync(10 * MIN - 1);
    expect(pullCalls()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(pullCalls()).toBe(2);
  });

  it("404 marks unavailable and stops", async () => {
    const { client, monitor, pullCalls } = setup();
    client.setResponse(PATHS.pull, {
      type: "error",
      status: 404,
      message: "Not Found",
      retryAfterMs: undefined,
    });
    const sub = attended();
    monitor.subscribe(URL, sub);
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(pullCalls()).toBe(1);
    expect(monitor.getStatus(URL)).toEqual({
      type: "unavailable",
      message: "Not Found",
    });
    expect(sub.onChange).toHaveBeenCalledTimes(1);
  });

  it("merged PR with no pending checks finishes", async () => {
    const { monitor, pullCalls } = setup({ state: "closed", merged: true });
    monitor.subscribe(URL, attended());
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(pullCalls()).toBe(1);
    expect(monitor.getStatus(URL)).toEqual({ type: "finished" });
    expect(monitor.getSnapshot(URL)?.state).toBe("merged");
  });

  it("keeps polling a merged PR while checks are pending", async () => {
    const { monitor, pullCalls } = setup({
      state: "closed",
      merged: true,
      runs: [{ name: "p", status: "in_progress" }],
    });
    monitor.subscribe(URL, attended());
    await vi.advanceTimersByTimeAsync(30_000);
    expect(pullCalls()).toBe(2);
  });

  describe("dormancy", () => {
    async function pollTimes(
      pullCalls: () => number,
      count: number,
    ): Promise<number[]> {
      const times: number[] = [];
      let seen = pullCalls();
      while (times.length < count) {
        await vi.advanceTimersByTimeAsync(1000);
        if (pullCalls() > seen) {
          seen = pullCalls();
          times.push(Date.now());
        }
      }
      return times;
    }
    const gaps = (times: number[]) =>
      times.slice(1).map((t, i) => (t - times[i]) / 1000);

    it("slows down when attention is old and resets on noteAttention", async () => {
      const { monitor, pullCalls } = setup();
      const lastAttention = Date.now() - 10 * MIN;
      monitor.subscribe(URL, {
        onChange: () => {},
        getLastAttention: () => lastAttention,
      });
      await vi.advanceTimersByTimeAsync(0);
      const start = Date.now();
      const times = await pollTimes(pullCalls, 5);
      expect(gaps([start, ...times])).toEqual([60, 120, 240, 300, 300]);
      await vi.advanceTimersByTimeAsync(100_000);
      monitor.noteAttention();
      await vi.advanceTimersByTimeAsync(0);
      expect(pullCalls()).toBe(7);
    });

    it("an attended subscriber keeps a shared poller at the base interval", async () => {
      const { monitor, pullCalls } = setup();
      monitor.subscribe(URL, {
        onChange: () => {},
        getLastAttention: () => Date.now() - 10 * MIN,
      });
      monitor.subscribe(URL, attended());
      await vi.advanceTimersByTimeAsync(0);
      const start = Date.now();
      const times = await pollTimes(pullCalls, 3);
      expect(gaps([start, ...times])).toEqual([30, 30, 30]);
    });

    it("failure backoff and dormancy combine as max", async () => {
      const { client, monitor, pullCalls } = setup();
      client.setResponse(PATHS.pull, {
        type: "error",
        status: 500,
        message: "boom",
        retryAfterMs: undefined,
      });
      monitor.subscribe(URL, {
        onChange: () => {},
        getLastAttention: () => Date.now() - 10 * MIN,
      });
      await vi.advanceTimersByTimeAsync(0);
      const start = Date.now();
      // failure: 60,120,240 ; dormancy: 60,120,240 -> then failure 480 vs 300
      const times = await pollTimes(pullCalls, 4);
      expect(gaps([start, ...times])).toEqual([60, 120, 240, 480]);
    });
  });
});
