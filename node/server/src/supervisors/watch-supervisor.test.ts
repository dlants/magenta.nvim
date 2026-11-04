import { expect, it } from "vitest";
import type { ThreadId } from "../chat-types.ts";
import type { ThreadCompactor } from "../compaction/compactor.ts";
import { parseOptions, parseProjectOptions } from "../config/options.ts";
import type { MockStream } from "../providers/mock-anthropic-client.ts";
import { type Harness, withHarness } from "../test/harness.ts";
import { created, setLastAttentionTime } from "../test-helpers.ts";
import type { Thread } from "../thread.ts";
import type { ToolName, ToolRequestId } from "../tool-types.ts";
import { pollUntil } from "../utils/async.ts";
import type { ResourceState } from "../watchers/protocol.ts";
import { diffBlobs } from "./watch-supervisor.ts";

const KEY = "o/r/pull/12";
const opts = {
  watchers: [
    {
      name: "gh",
      protocolVersion: 1 as const,
      command: ["true"],
      triggers: [
        { pattern: "https://github\\.com/(\\S+/pull/\\d+)", keyGroup: 1 },
      ],
    },
  ],
};
const active = (context: string): ResourceState => ({
  key: KEY,
  status: "active",
  context,
  summary: "open",
});
const text = (stream: MockStream) =>
  JSON.stringify(stream.messages.filter((m) => m.role === "user").at(-1));

async function exchange(h: Harness, thread: Thread, msg: string) {
  const done = h.send(thread, msg);
  const stream = await h.nextStream();
  stream.respond({ stopReason: "end_turn", text: "ok", toolRequests: [] });
  await done;
  return stream;
}
async function mention(h: Harness, thread: Thread) {
  await exchange(h, thread, `watch https://github.com/${KEY}`);
  await pollUntil(() => {
    if (thread.watchedResources[0]?.state?.status !== "active")
      throw new Error("not subscribed yet");
  });
}

it("diffBlobs reports only changed lines", () => {
  expect(diffBlobs("a\nb\nc\n", "a\nB\nc\n")).toBe("- b\n+ B");
});

it("delivers the full blob first, then line diffs, then nothing", () =>
  withHarness(opts, async (h) => {
    h.host.watchers.push("gh", active("state: open\nchecks: pending\n"));
    const { thread } = await h.createRoot();
    await mention(h, thread);
    expect(h.host.watchers.subscriberCount("gh", KEY)).toBe(1);
    const first = text(await exchange(h, thread, "status?"));
    expect(first).toContain("# Watched resource update");
    expect(first).toContain("checks: pending");
    const delivery = [...thread.contextDeliveries.values()].find(
      (d) => d.watched,
    );
    expect(delivery?.watched?.resources[0]?.kind).toBe("full");

    h.host.watchers.push("gh", active("state: open\nchecks: pending\n"));
    expect(thread.watchedResources[0]?.pendingUpdate).toBe(false);
    expect(text(await exchange(h, thread, "again"))).not.toContain(
      "# Watched resource update",
    );

    h.host.watchers.push("gh", active("state: open\nchecks: failed\n"));
    expect(thread.watchedResources[0]?.pendingUpdate).toBe(true);
    const diff = text(await exchange(h, thread, "now?"));
    expect(diff).toContain("- checks: pending");
    expect(diff).toContain("+ checks: failed");
    expect(diff).not.toContain("state: open");
  }));

it("a rejected key shows as unavailable and injects nothing", () =>
  withHarness(opts, async (h) => {
    h.host.watchers.push("gh", {
      key: KEY,
      status: "unavailable",
      context: "",
      summary: "not allowed",
      error: "repo not watched",
    });
    const { thread } = await h.createRoot();
    await exchange(h, thread, `see https://github.com/${KEY}`);
    await pollUntil(() => {
      if (thread.watchedResources[0]?.state?.status !== "unavailable")
        throw new Error("not yet");
    });
    expect(text(await exchange(h, thread, "hi"))).not.toContain(
      "# Watched resource update",
    );
  }));

it("an unreachable watcher degrades to unavailable; submissions succeed", () =>
  withHarness(opts, async (h) => {
    h.host.watchers.unreachable.add("gh");
    const { thread } = await h.createRoot();
    await exchange(h, thread, `see https://github.com/${KEY}`);
    await pollUntil(() => {
      const s = thread.watchedResources[0]?.state;
      if (s?.status !== "unavailable") throw new Error("not yet");
      expect(s.error).toContain("unreachable");
    });
    await exchange(h, thread, "still works");
  }));

it("forks diff against the blob seen at the fork point", () =>
  withHarness(opts, async (h) => {
    h.host.watchers.push("gh", active("v1\n"));
    const { id, thread } = await h.createRoot();
    await mention(h, thread);
    const beforeDelivery = thread.nativeMessageIdx;
    await exchange(h, thread, "status?");

    const early = h.thread(
      await created(h.session.forkThread(id, beforeDelivery)),
    );
    await pollUntil(() => {
      if (early.watchedResources[0]?.state?.status !== "active")
        throw new Error("fork has not re-tracked yet");
    });
    expect(text(await exchange(h, early, "fork"))).toContain("v1");

    const late = h.thread(
      await created(h.session.forkThread(id, thread.nativeMessageIdx)),
    );
    await pollUntil(() => {
      if (late.watchedResources[0]?.state?.status !== "active")
        throw new Error("not tracked");
    });
    h.host.watchers.push("gh", active("v2\n"));
    const lateText = text(await exchange(h, late, "fork"));
    expect(lateText).toContain("- v1");
    expect(lateText).toContain("+ v2");
  }));

function compactorOf(h: Harness, id: ThreadId): ThreadCompactor {
  const record = h.session.getThread(id);
  if (record?.state !== "initialized" || !record.compactor)
    throw new Error("thread has no compactor");
  return record.compactor;
}

it("compaction replacement does not re-deliver an already-seen blob", () =>
  withHarness(opts, async (h) => {
    h.host.watchers.push("gh", active("seen\n"));
    const { id, thread } = await h.createRoot();
    await mention(h, thread);
    await exchange(h, thread, "status?");
    const done = h.send(thread, "@compact");
    await pollUntil(() => {
      if (!compactorOf(h, id).current) throw new Error("not compacting");
    });
    const tool = (id: string, toolName: string, input: unknown) => ({
      status: "ok" as const,
      value: {
        id: id as ToolRequestId,
        toolName: toolName as ToolName,
        input,
      },
    });
    (await h.nextStream()).respond({
      stopReason: "tool_use",
      text: "Compacting.",
      toolRequests: [
        tool("edl_1", "edl", {
          script:
            "file `/summary.md`\nselect bof-eof\nreplace <<S\n# Summary\nnothing\nS",
        }),
      ],
    });
    (await h.nextStream()).respond({
      stopReason: "tool_use",
      text: "Done.",
      toolRequests: [
        tool("yield_1", "yield_to_parent", { result: "wrote /summary.md" }),
      ],
    });
    const after = await h.nextStream();
    expect(text(after)).not.toContain("# Watched resource update");
    after.respond({ stopReason: "end_turn", text: "ok", toolRequests: [] });
    await done;
    expect(thread.watchedResources.map((r) => r.key)).toEqual([KEY]);
  }));

it("dormancy unsubscribes; attention resubscribes and injects one diff", () =>
  withHarness(opts, async (h) => {
    h.host.watchers.push("gh", active("a\n"));
    const { id, thread } = await h.createRoot();
    await mention(h, thread);
    await exchange(h, thread, "status?");
    setLastAttentionTime(h.session, id, 0);
    thread.noteAttention();
    expect(h.host.watchers.subscriberCount("gh", KEY)).toBe(0);
    expect(thread.watchedResources[0]?.paused).toBe(true);
    h.host.watchers.push("gh", active("b\n"));
    h.host.watchers.push("gh", active("c\n"));
    expect(thread.watchedResources[0]?.state?.context).toBe("a\n");

    h.session.markAttended(id);
    await pollUntil(() => {
      if (thread.watchedResources[0]?.state?.context !== "c\n")
        throw new Error("not resubscribed");
    });
    expect(h.host.watchers.subscriberCount("gh", KEY)).toBe(1);
    const resumed = text(await exchange(h, thread, "now?"));
    expect(resumed).toContain("- a");
    expect(resumed).toContain("+ c");
    expect(resumed).not.toContain("+ b");
  }));

it("deleting the thread closes its watcher connection", () =>
  withHarness(opts, async (h) => {
    h.host.watchers.push("gh", active("a\n"));
    const { id, thread } = await h.createRoot();
    await mention(h, thread);
    h.session.deleteThread(id);
    await pollUntil(() => {
      if (h.host.watchers.subscriberCount("gh", KEY) !== 0)
        throw new Error("still subscribed");
    });
  }));

it("watchers is a user-level option only", () => {
  const logger = { warn: () => {}, error: () => {} };
  expect(
    parseOptions({ watchers: ["~/w/manifest.json"] }, logger).watchers,
  ).toEqual(["~/w/manifest.json"]);
  expect(
    "watchers" in parseProjectOptions({ watchers: ["/evil.json"] }, logger),
  ).toBe(false);
});
