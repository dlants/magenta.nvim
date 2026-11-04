import { afterEach, describe, expect, it, vi } from "vitest";
import type { ThreadId } from "../chat-types.ts";
import type { ThreadCompactor } from "../compaction/compactor.ts";
import { parseOptions, parseProjectOptions } from "../config/options.ts";
import type { MockStream } from "../providers/mock-anthropic-client.ts";
import type { NativeMessageIdx } from "../providers/provider-types.ts";
import { FakeWatcherTransport } from "../test/fakes.ts";
import { type Harness, withHarness } from "../test/harness.ts";
import { created, noopLogger, setLastAttentionTime } from "../test-helpers.ts";
import type { Thread } from "../thread.ts";
import type { ToolName, ToolRequestId } from "../tool-types.ts";
import { pollUntil } from "../utils/async.ts";
import type { HomeDir } from "../utils/files.ts";
import type { ResourceState, WatcherName } from "../watchers/protocol.ts";
import { WatcherRegistry } from "../watchers/watcher-registry.ts";
import { diffBlobs, WatchSupervisor } from "./watch-supervisor.ts";

const KEY = "o/r/pull/12";
const opts = {
  watchers: [
    {
      name: "gh" as WatcherName,
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

describe("WatchSupervisor connection handling", () => {
  const GH = "gh" as WatcherName;
  const ref = { watcher: GH, key: KEY };
  const idx = (n: number) => ({
    outputTokenCount: 0,
    nativeMessageIdx: n as NativeMessageIdx,
  });
  function setup() {
    const transport = new FakeWatcherTransport();
    const registry = new WatcherRegistry({
      transport,
      homeDir: "/home" as HomeDir,
      logger: noopLogger,
    });
    registry.setManifests([
      { ...opts.watchers[0], dir: "/w", socketPath: "/w/gh.sock" },
    ]);
    const supervisor = WatchSupervisor.create({ registry });
    return { transport, supervisor };
  }
  const injected = async (s: WatchSupervisor, n: number) => {
    const action = await s.onBeforeRequest(idx(n));
    return action.type === "inject" ? JSON.stringify(action.content) : "";
  };
  afterEach(() => vi.useRealTimers());

  it("resubscribes after the connection drops and diffs the next change", async () => {
    vi.useFakeTimers();
    const { transport, supervisor } = setup();
    transport.push(GH, active("v1\n"));
    supervisor.track(ref);
    await vi.waitFor(() =>
      expect(supervisor.getViewState()[0]?.state?.context).toBe("v1\n"),
    );
    expect(await injected(supervisor, 1)).toContain("v1");

    transport.dropConnections(GH);
    expect(transport.subscriberCount(GH, KEY)).toBe(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(transport.subscriberCount(GH, KEY)).toBe(1);
    expect(transport.connections.filter((c) => !c.closed)).toHaveLength(1);

    transport.push(GH, active("v2\n"));
    const diff = await injected(supervisor, 3);
    expect(diff).toContain("- v1");
    expect(diff).toContain("+ v2");
    supervisor.dispose();
  });

  it("does not resubscribe after dispose", async () => {
    vi.useFakeTimers();
    const { transport, supervisor } = setup();
    supervisor.track(ref);
    await vi.waitFor(() => expect(transport.subscriberCount(GH, KEY)).toBe(1));
    transport.dropConnections(GH);
    supervisor.dispose();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(transport.connections).toHaveLength(1);
  });

  it("a rejected resubscribe keeps the last context and summary", async () => {
    vi.useFakeTimers();
    const { transport, supervisor } = setup();
    transport.push(GH, active("v1\n"));
    supervisor.track(ref);
    await vi.waitFor(() =>
      expect(supervisor.getViewState()[0]?.state?.status).toBe("active"),
    );
    transport.rejectSubscribe.add(KEY);
    transport.dropConnections(GH);
    await vi.advanceTimersByTimeAsync(1_000);
    const state = supervisor.getViewState()[0]?.state;
    expect(state).toMatchObject({
      status: "unavailable",
      context: "v1\n",
      summary: "open",
    });
    supervisor.dispose();
  });

  it("ignores a subscribe result that lands after going dormant", async () => {
    let attention = Date.now();
    const transport = new FakeWatcherTransport();
    const registry = new WatcherRegistry({
      transport,
      homeDir: "/home" as HomeDir,
      logger: noopLogger,
    });
    registry.setManifests([
      { ...opts.watchers[0], dir: "/w", socketPath: "/w/gh.sock" },
    ]);
    const supervisor = WatchSupervisor.create({
      registry,
      getLastAttention: () => attention,
    });
    let release = () => {};
    transport.holdSubscribes = new Promise((r) => {
      release = r;
    });
    transport.push(GH, active("v1\n"));
    supervisor.track(ref);
    attention = 0;
    supervisor.noteAttention();
    release();
    await new Promise((r) => setTimeout(r, 0));
    expect(supervisor.getViewState()[0]?.state).toBeUndefined();
    expect(supervisor.getViewState()[0]?.paused).toBe(true);
    supervisor.dispose();
  });
});
