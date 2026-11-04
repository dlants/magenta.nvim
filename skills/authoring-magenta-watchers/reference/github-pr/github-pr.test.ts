import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseWatcherManifest } from "../../../../node/server/src/watchers/protocol.ts";
import {
  type ExecFileFn,
  GhCliGitHubClient,
  parseGhApiOutput,
  rateLimitDelayMs,
} from "./github.ts";
import {
  isFinished,
  makePoll,
  type PollState,
  render,
  summarize,
} from "./pull-request.ts";

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

type Reply = {
  status: number;
  body?: unknown;
  etag?: string;
  headers?: string[];
};

/** Fake `gh api --include`: routes by path, replies with an HTTP dump. */
function fakeGh() {
  const replies = new Map<string, Reply>();
  const calls: { path: string; etag: string | undefined }[] = [];
  const execFile: ExecFileFn = async (_file, args) => {
    const path = args[args.length - 1] ?? "";
    const h = args.indexOf("-H");
    const etag =
      h === -1 ? undefined : args[h + 1]?.replace("If-None-Match: ", "");
    calls.push({ path, etag });
    const reply = replies.get(path) ?? {
      status: 404,
      body: { message: "Not Found" },
    };
    if (
      reply.status === 304 ||
      (reply.etag !== undefined && etag === reply.etag)
    ) {
      return {
        stdout: "HTTP/2.0 304 Not Modified\n\n",
        stderr: "",
        exitCode: 0,
      };
    }
    const headers = [
      ...(reply.etag ? [`ETag: ${reply.etag}`] : []),
      ...(reply.headers ?? []),
    ];
    return {
      stdout: `HTTP/2.0 ${reply.status} X\n${headers.join("\n")}\n\n${JSON.stringify(reply.body ?? null)}`,
      stderr: "",
      exitCode: reply.status < 400 ? 0 : 1,
    };
  };
  const set = (path: string, body: unknown, etag = `"${path}"`) =>
    replies.set(path, { status: 200, body, etag });
  const setPr = (
    pr: { state?: string; merged?: boolean } = {},
    etag?: string,
  ) =>
    set(
      PATHS.pull,
      {
        title: "T",
        state: pr.state ?? "open",
        merged: pr.merged ?? false,
        draft: false,
        head: { sha: "sha1" },
      },
      etag,
    );
  setPr();
  set(PATHS.checkRuns, { total_count: 0, check_runs: [] });
  set(PATHS.status, { statuses: [] });
  set(PATHS.issueComments, []);
  set(PATHS.reviewComments, []);
  set(PATHS.reviews, []);
  const poll = makePoll(new GhCliGitHubClient({ execFile }));
  const signal = new AbortController().signal;
  const run = (previous?: PollState) => poll(URL, { previous, signal });
  return { replies, calls, set, setPr, run };
}

async function ok(p: Promise<unknown>): Promise<PollState> {
  const r = (await p) as { kind: string; snapshot?: PollState };
  if (r.kind !== "ok" || !r.snapshot) throw new Error(JSON.stringify(r));
  return r.snapshot;
}

describe("github-pr watcher", () => {
  it("normalizes check runs, statuses and comments", async () => {
    const gh = fakeGh();
    gh.set(PATHS.checkRuns, {
      total_count: 200,
      check_runs: [
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
    gh.set(PATHS.status, {
      statuses: [
        { context: "e", state: "error", target_url: "t" },
        { context: "x", state: "failure" },
        { context: "y", state: "pending" },
      ],
    });
    gh.set(PATHS.reviewComments, [
      {
        id: 4,
        user: { login: "bot" },
        body: "b",
        html_url: "h",
        updated_at: "t1",
        path: "a.ts",
        line: 3,
      },
    ]);
    gh.set(PATHS.reviews, [
      {
        id: 5,
        user: { login: "me" },
        body: "",
        state: "APPROVED",
        submitted_at: "t2",
        html_url: "h2",
      },
    ]);
    const { pr } = await ok(gh.run());
    expect(
      pr.checks.map((c) => `${c.name}:${c.status}:${c.url ?? ""}`),
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
    expect(pr.truncated).toBe(true);
    expect(pr.comments.map((c) => c.id)).toEqual([
      "review_comment:4",
      "review:5",
    ]);
    const state = await ok(gh.run());
    const text = render(state);
    expect(text).toContain(`## ${URL}`);
    expect(text).toContain(
      "- Checks: 3 pending, 1 success, 3 failure, 1 neutral, 1 skipped",
    );
    expect(text).toContain("### review comment by bot on a.ts:3 (updated t1)");
    expect(text).toContain("### review by me (APPROVED) (updated t2)");
    expect(text).toContain("truncated");
    const { summary, details } = summarize(state);
    expect(summary).toBe(
      "o/r#12 open: T, checks: 3 pending, 1 success, 3 failure, 1 neutral, 1 skipped, 2 comments",
    );
    expect(details).toContain("- s: success u");
  });

  it("sends stored etags; 304s reuse the cached body", async () => {
    const gh = fakeGh();
    const first = await ok(gh.run());
    expect(gh.calls.every((c) => c.etag === undefined)).toBe(true);
    gh.calls.length = 0;
    const second = await ok(gh.run(first));
    expect(gh.calls.map((c) => c.etag)).toEqual(
      Object.values(PATHS).map((p) => `"${p}"`),
    );
    expect(render(second)).toBe(render(first));
  });

  it("a comment edit changes the render; an etag-only change does not", async () => {
    const gh = fakeGh();
    const comment = {
      id: 1,
      user: { login: "a" },
      body: "x",
      html_url: "h",
      updated_at: "t1",
    };
    gh.set(PATHS.issueComments, [comment]);
    const first = await ok(gh.run());
    gh.setPr({}, '"new-etag"');
    const same = await ok(gh.run(first));
    expect(render(same)).toBe(render(first));
    gh.set(
      PATHS.issueComments,
      [{ ...comment, body: "y", updated_at: "t2" }],
      '"c2"',
    );
    const edited = await ok(gh.run(same));
    expect(render(edited)).not.toBe(render(first));
    expect(render(edited)).toContain("(updated t2)");
  });

  it("a failing endpoint is an error and does not commit the cache", async () => {
    const gh = fakeGh();
    const first = await ok(gh.run());
    gh.replies.set(PATHS.reviews, { status: 500, body: { message: "boom" } });
    expect(await gh.run(first)).toEqual({
      kind: "error",
      error: "GitHub API returned 500: boom",
    });
  });

  it("304 without a cached body is an error", async () => {
    const gh = fakeGh();
    gh.replies.set(PATHS.reviews, { status: 304 });
    expect(await gh.run()).toEqual({
      kind: "error",
      error: `304 without a cached body for ${PATHS.reviews}`,
    });
  });

  it("fetches new check paths after a head change", async () => {
    const gh = fakeGh();
    const first = await ok(gh.run());
    const head2 = `${BASE}/commits/sha2/check-runs?per_page=100`;
    gh.set(
      PATHS.pull,
      { title: "T", state: "open", head: { sha: "sha2" } },
      '"p2"',
    );
    gh.set(head2, { total_count: 0, check_runs: [] });
    gh.set(`${BASE}/commits/sha2/status`, { statuses: [] });
    gh.calls.length = 0;
    const second = await ok(gh.run(first));
    expect(gh.calls.find((c) => c.path === head2)?.etag).toBeUndefined();
    expect(second.pr.headSha).toBe("sha2");
  });

  it("404 is unavailable; a non-PR key is unavailable without calling gh", async () => {
    const gh = fakeGh();
    gh.replies.delete(PATHS.pull);
    expect(await gh.run()).toEqual({
      kind: "unavailable",
      error: "GitHub API returned 404: Not Found",
    });
    gh.calls.length = 0;
    const poll = makePoll(
      new GhCliGitHubClient({
        execFile: async () => {
          throw new Error("no");
        },
      }),
    );
    expect(
      await poll("https://example.com/x", {
        previous: undefined,
        signal: new AbortController().signal,
      }),
    ).toEqual({
      kind: "unavailable",
      error: "Not a pull request URL: https://example.com/x",
    });
  });

  it("finishes once closed/merged with no pending checks", async () => {
    const gh = fakeGh();
    expect(isFinished(await ok(gh.run()))).toBe(false);
    gh.setPr({ state: "closed", merged: true }, '"m"');
    gh.set(
      PATHS.checkRuns,
      { total_count: 1, check_runs: [{ name: "c", status: "in_progress" }] },
      '"c1"',
    );
    const pending = await ok(gh.run());
    expect(isFinished(pending)).toBe(false);
    expect(pending.pr.state).toBe("merged");
    gh.set(
      PATHS.checkRuns,
      {
        total_count: 1,
        check_runs: [{ name: "c", status: "completed", conclusion: "success" }],
      },
      '"c2"',
    );
    expect(isFinished(await ok(gh.run(pending)))).toBe(true);
  });

  it("manifest trigger matches PR URLs and parses with the server parser", async () => {
    const raw = JSON.parse(
      readFileSync(
        new globalThis.URL("./manifest.json", import.meta.url),
        "utf8",
      ),
    );
    const trigger = raw.triggers[0];
    const re = new RegExp(trigger.pattern, "g");
    const text = `see ${URL} and https://github.com/a/b/issues/3 and https://github.com/a/b/pull/7.`;
    expect([...text.matchAll(re)].map((m) => m[trigger.keyGroup])).toEqual([
      URL,
      "https://github.com/a/b/pull/7",
    ]);
    expect(parseWatcherManifest).toBeTypeOf("function");
  });
});

describe("parseGhApiOutput", () => {
  const out = (stdout: string, stderr = "", exitCode = 0) =>
    parseGhApiOutput({ stdout, stderr, exitCode }, 0);
  it.each([
    [
      "missing status line falls back to stderr",
      out("", "boom", 1),
      {
        type: "error",
        status: undefined,
        message: "boom",
        retryAfterMs: undefined,
      },
    ],
    ["304", out("HTTP/2.0 304 Not Modified\r\n\r\n"), { type: "not-modified" }],
    [
      "2xx empty body",
      out('HTTP/2.0 200 OK\r\nEtag: "e"\r\n\r\n'),
      { type: "ok", body: undefined, etag: '"e"' },
    ],
    [
      "2xx json body with CRLF headers",
      out('HTTP/2.0 200 OK\r\nETag: "x"\r\nA: b\r\n\r\n{"a":1}'),
      { type: "ok", body: { a: 1 }, etag: '"x"' },
    ],
    [
      "error with json message",
      out('HTTP/2.0 404 Not Found\n\n{"message":"Not Found"}'),
      {
        type: "error",
        status: 404,
        message: "GitHub API returned 404: Not Found",
        retryAfterMs: undefined,
      },
    ],
  ])("%s", (_name, actual, expected) => {
    expect(actual).toEqual(expected);
  });
  it("2xx with bad json is a parse error", () => {
    const r = out("HTTP/2.0 200 OK\n\n{nope");
    expect(r.type).toBe("error");
    if (r.type === "error") {
      expect(r.status).toBe(200);
      expect(r.message).toMatch(/Failed to parse/);
    }
  });
});

describe("rateLimitDelayMs", () => {
  const h = (o: Record<string, string>) => new Map(Object.entries(o));
  it("429 with retry-after", () => {
    expect(rateLimitDelayMs(429, h({ "retry-after": "7" }), 0)).toBe(7000);
  });
  it("403 with remaining=0 and reset", () => {
    expect(
      rateLimitDelayMs(
        403,
        h({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": "100" }),
        40_000,
      ),
    ).toBe(60_000);
  });
  it("403 without rate-limit headers", () => {
    expect(rateLimitDelayMs(403, h({}), 0)).toBeUndefined();
  });
  it("non-rate-limit status ignores headers", () => {
    expect(rateLimitDelayMs(500, h({ "retry-after": "7" }), 0)).toBeUndefined();
  });
});
