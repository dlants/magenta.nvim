import { expect, it } from "vitest";
import type { GitHubResponse } from "../capabilities/github-client.ts";
import type { ThreadId } from "../chat-types.ts";
import type { ThreadCompactor } from "../compaction/compactor.ts";
import type { MockStream } from "../providers/mock-anthropic-client.ts";
import type { PullRequestSnapshot } from "../pull-requests/types.ts";
import { type Harness, withHarness } from "../test/harness.ts";
import { created } from "../test-helpers.ts";
import type { Thread } from "../thread.ts";
import type { ToolName, ToolRequestId } from "../tool-types.ts";
import { pollUntil } from "../utils/async.ts";
import {
  diffSnapshots,
  pullRequestUpdateToText,
} from "./pull-request-supervisor.ts";

const URL = "https://github.com/o/r/pull/12";
const ok = (body: unknown): GitHubResponse => ({
  type: "ok",
  body,
  etag: undefined,
});
// Fixtures mirror `gh api` JSON, where absent conclusions are `null`.
type Run = { name: string; status: string; conclusion: string | null };
type Comment = { id: number; body: string; updated_at: string };

function script(
  h: Harness,
  pr: { sha?: string; runs?: Run[]; comments?: Comment[] } = {},
) {
  const sha = pr.sha ?? "sha1";
  const gh = h.host.github;
  gh.setResponse(
    "repos/o/r/pulls/12",
    ok({
      title: "Fix it",
      state: "open",
      merged: false,
      draft: false,
      head: { sha },
    }),
  );
  const runs = pr.runs ?? [];
  gh.setResponse(
    `repos/o/r/commits/${sha}/check-runs?per_page=100`,
    ok({
      total_count: runs.length,
      check_runs: runs.map((r) => ({ ...r, html_url: `https://ci/${r.name}` })),
    }),
  );
  gh.setResponse(`repos/o/r/commits/${sha}/status`, ok({ statuses: [] }));
  gh.setResponse(
    "repos/o/r/issues/12/comments?per_page=100",
    ok(
      (pr.comments ?? []).map((c) => ({
        ...c,
        user: { login: "alice" },
        html_url: `https://c/${c.id}`,
      })),
    ),
  );
  gh.setResponse("repos/o/r/pulls/12/comments?per_page=100", ok([]));
  gh.setResponse("repos/o/r/pulls/12/reviews?per_page=100", ok([]));
}

const lint = (conclusion: string | null): Run => ({
  name: "lint",
  status: conclusion ? "completed" : "in_progress",
  conclusion,
});
const comment = (id: number, body: string, updated_at = "t1"): Comment => ({
  id,
  body,
  updated_at,
});
/** The last user message: the one carrying this request's injections. */
const text = (stream: MockStream) =>
  JSON.stringify(stream.messages.filter((m) => m.role === "user").at(-1));
const pullCalls = (h: Harness) =>
  h.host.github.calls.filter((c) => c.path === "repos/o/r/pulls/12").length;

async function exchange(h: Harness, thread: Thread, msg: string) {
  const done = h.send(thread, msg);
  const stream = await h.nextStream();
  stream.respond({ stopReason: "end_turn", text: "ok", toolRequests: [] });
  await done;
  return stream;
}
/** Waits for the monitor to apply a poll whose snapshot satisfies `check`. */
const waitSnapshot = (h: Harness, check: (s: string) => boolean) =>
  pollUntil(() => {
    const snapshot = h.session.pullRequestMonitor?.getSnapshot(URL);
    if (!snapshot || !check(JSON.stringify(snapshot)))
      throw new Error("snapshot not ready");
  });
async function mention(h: Harness, thread: Thread) {
  await exchange(h, thread, `Please watch ${URL}`);
  await waitSnapshot(h, () => true);
}

const opts = { pullRequestPollIntervalMs: 10 };

it("delivers the full snapshot first, then only diffs", () =>
  withHarness(opts, async (h) => {
    script(h, { runs: [lint(null)], comments: [comment(1, "first!")] });
    const { thread } = await h.createRoot();
    await mention(h, thread);

    const second = await exchange(h, thread, "status?");
    const first = text(second);
    expect(first).toContain("# Pull request update");
    expect(first).toContain("Now tracking this pull request");
    expect(first).toContain("lint: pending");
    expect(first).toContain("first!");
    const idx = [...thread.contextDeliveries].find(([, d]) => d.pullRequests);
    expect(idx?.[1].pullRequests?.pullRequests[0]?.type).toBe("tracked");

    expect(text(await exchange(h, thread, "again"))).not.toContain(
      "# Pull request update",
    );

    script(h, {
      runs: [lint("failure")],
      comments: [comment(1, "first!"), comment(2, "lint broke")],
    });
    await waitSnapshot(h, (s) => s.includes("lint broke"));
    const diff = text(await exchange(h, thread, "now?"));
    expect(diff).toContain("lint: failure (was pending)");
    expect(diff).toContain("lint broke");
    expect(diff).not.toContain("first!");
  }));

it("reports edited comments and the full check set on a head change", () =>
  withHarness(opts, async (h) => {
    script(h, { runs: [lint("success")], comments: [comment(1, "v1")] });
    const { thread } = await h.createRoot();
    await mention(h, thread);
    await exchange(h, thread, "status?");
    script(h, {
      sha: "sha2",
      runs: [lint("success")],
      comments: [comment(1, "v2", "t2")],
    });
    await waitSnapshot(h, (s) => s.includes("sha2"));
    const update = text(await exchange(h, thread, "now?"));
    expect(update).toContain("Head: sha1 -> sha2");
    expect(update).toContain("lint: success");
    expect(update).toContain("Edited issue by alice");
    expect(update).toContain("v2");
  }));

it("an idle thread does not start a request, but has pending content", () =>
  withHarness(opts, async (h) => {
    script(h);
    const { thread } = await h.createRoot();
    await mention(h, thread);
    await exchange(h, thread, "status?");
    script(h, { comments: [comment(5, "ping")] });
    await waitSnapshot(h, (s) => s.includes("ping"));
    expect(thread.state.type).toBe("idle");
    expect(h.mockClient.streams.length).toBe(2);
    expect(text(await exchange(h, thread, "hi"))).toContain("ping");
  }));

it("forks keep the agent view at the fork point", () =>
  withHarness(opts, async (h) => {
    script(h, { comments: [comment(1, "hello")] });
    const { id, thread } = await h.createRoot();
    await mention(h, thread);
    const beforeDelivery = thread.nativeMessageIdx;
    await exchange(h, thread, "status?");

    const early = h.thread(
      await created(h.session.forkThread(id, beforeDelivery)),
    );
    await pollUntil(() => {
      if (!early.trackedPullRequests.length)
        throw new Error("fork has not re-tracked yet");
    });
    expect(text(await exchange(h, early, "fork"))).toContain(
      "Now tracking this pull request",
    );

    const late = h.thread(
      await created(h.session.forkThread(id, thread.nativeMessageIdx)),
    );
    expect(text(await exchange(h, late, "fork"))).not.toContain(
      "# Pull request update",
    );
  }));

function compactorOf(h: Harness, id: ThreadId): ThreadCompactor {
  const record = h.session.getThread(id);
  if (record?.state !== "initialized" || !record.compactor)
    throw new Error("thread has no compactor");
  return record.compactor;
}

it("compaction replacement keeps the shared poller warm", () =>
  withHarness({}, async (h) => {
    script(h);
    const { id, thread } = await h.createRoot();
    await mention(h, thread);
    const calls = pullCalls(h);
    const done = h.send(thread, "@compact");
    await pollUntil(() => {
      if (!compactorOf(h, id).current) throw new Error("not compacting");
    });
    const compactStream = await h.nextStream();
    expect(text(compactStream)).not.toContain("# Pull request update");
    compactStream.respond({
      stopReason: "tool_use",
      text: "Compacting.",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: "edl_1" as ToolRequestId,
            toolName: "edl" as ToolName,
            input: {
              script:
                "file `/summary.md`\nselect bof-eof\nreplace <<S\n# Summary\nnothing\nS",
            },
          },
        },
      ],
    });
    (await h.nextStream()).respond({
      stopReason: "tool_use",
      text: "Done.",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: "yield_1" as ToolRequestId,
            toolName: "yield_to_parent" as ToolName,
            input: { result: "wrote /summary.md" },
          },
        },
      ],
    });
    const after = await h.nextStream();
    expect(text(after)).toContain("Now tracking this pull request");
    after.respond({ stopReason: "end_turn", text: "ok", toolRequests: [] });
    await done;
    expect(thread.trackedPullRequests).toEqual([URL]);
    expect(pullCalls(h)).toBe(calls);
  }));

it("deleting the thread unsubscribes from the shared poller", () =>
  withHarness(opts, async (h) => {
    script(h);
    const { id, thread } = await h.createRoot();
    await mention(h, thread);
    h.session.deleteThread(id);
    await pollUntil(() => {
      if (h.session.pullRequestMonitor?.getStatus(URL) !== undefined)
        throw new Error("still subscribed");
    });
    const calls = pullCalls(h);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(pullCalls(h)).toBe(calls);
  }));

it("diffs state changes and formats review comments", () => {
  const base: PullRequestSnapshot = {
    ref: { url: URL, owner: "o", repo: "r", number: 12 },
    title: "Fix it",
    state: "open",
    draft: false,
    headSha: "sha1",
    checks: [{ name: "lint", status: "success", url: undefined }],
    comments: [],
    truncated: false,
  };
  expect(diffSnapshots(base, { ...base })).toBeUndefined();
  const merged = diffSnapshots(base, {
    ...base,
    state: "merged",
    comments: [
      {
        id: "review_comment:5",
        kind: "review_comment",
        author: "bob",
        body: "nit here",
        url: "https://c/5",
        updatedAt: "t1",
        path: "a.ts",
        line: 3,
      },
    ],
  });
  expect(merged).toMatchObject({
    type: "changed",
    stateChange: { from: "open", to: "merged" },
    checks: [],
  });
  const rendered = pullRequestUpdateToText({
    pullRequests: merged ? [merged] : [],
  });
  expect(rendered).toContain("merged");
  expect(rendered).toContain("a.ts:3");
  expect(rendered).toContain("nit here");
});
