import { afterEach, describe, expect, it, vi } from "vitest";
import type { ThreadId } from "../chat-types.ts";
import type { ThreadCompactor } from "../compaction/compactor.ts";
import { parseOptions, parseProjectOptions } from "../config/options.ts";
import { createInProcessServer } from "../protocol/server.ts";
import type { ProtocolThreadState } from "../protocol/state.ts";
import type { MockStream } from "../providers/mock-anthropic-client.ts";
import type { NativeMessageIdx } from "../providers/provider-types.ts";
import { FakeWatcherTransport } from "../test/fakes.ts";
import { type Harness, withHarness } from "../test/harness.ts";
import { created, noopLogger, setLastAttentionTime } from "../test-helpers.ts";
import type { Thread } from "../thread.ts";
import type { ToolName, ToolRequestId } from "../tool-types.ts";
import { Defer, pollUntil } from "../utils/async.ts";
import type { HomeDir } from "../utils/files.ts";
import type { ResourceState, WatcherName } from "../watchers/protocol.ts";
import { WatcherRegistry } from "../watchers/watcher-registry.ts";
import { diffBlobs, WatchSupervisor } from "./watch-supervisor.ts";

const KEY = "o/r/pull/12";
const GH = "gh" as WatcherName;
const opts = {
  watchers: [
    {
      name: "gh" as WatcherName,
      protocolVersion: 1 as const,
      command: ["true"],
    },
  ],
};
const ghScan = (texts: string[]) =>
  texts.flatMap((t) =>
    [...t.matchAll(/https:\/\/github\.com\/(\S+\/pull\/\d+)/g)].map(
      (m) => m[1] ?? "",
    ),
  );
function withGh(fn: (h: Harness) => Promise<void>) {
  return withHarness(opts, (h) => {
    h.host.watchers.scanners.set(GH, ghScan);
    return fn(h);
  });
}
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
  withGh(async (h) => {
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

it("watcher output is injected as context and is not scanned", () =>
  withGh(async (h) => {
    h.host.watchers.push(
      "gh",
      active("related: https://github.com/o/r/pull/99\n"),
    );
    const { thread } = await h.createRoot();
    await mention(h, thread);
    const stream = await exchange(h, thread, "status?");
    expect(text(stream)).toContain("<context_update>");
    await exchange(h, thread, "again");
    expect(thread.watchedResources.map((r) => r.key)).toEqual([KEY]);
    expect(JSON.stringify(h.host.watchers.scanCalls)).not.toContain("pull/99");
  }));

it("a rejected key shows as unavailable and injects nothing", () =>
  withGh(async (h) => {
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

it("a failed scan tracks nothing, logs, and submissions succeed", () =>
  withGh(async (h) => {
    const errors = vi.spyOn(noopLogger, "error");
    h.host.watchers.unreachable.add("gh");
    const { thread } = await h.createRoot();
    await exchange(h, thread, `see https://github.com/${KEY}`);
    await pollUntil(() => {
      if (!errors.mock.calls.some((c) => String(c[0]).includes("scan failed")))
        throw new Error("not logged yet");
    });
    expect(thread.watchedResources).toEqual([]);
    await exchange(h, thread, "still works");
    errors.mockRestore();
  }));

it("two mentions the watcher canonicalizes to one key track one resource", () =>
  withHarness(opts, async (h) => {
    h.host.watchers.scanners.set(GH, (texts) =>
      texts.some((t) => /\/repo\/\w+\.ts/.test(t)) ? ["/repo"] : [],
    );
    const { thread } = await h.createRoot();
    await exchange(h, thread, "edit /repo/a.ts and /repo/b.ts");
    await pollUntil(() =>
      expect(thread.watchedResources.map((r) => r.key)).toEqual(["/repo"]),
    );
  }));

it("scans text, tool input and tool results but not injected context", () =>
  withGh(async (h) => {
    const { thread } = await h.createRoot();
    const done = h.send(thread, "user line1\nline2");
    const s1 = await h.nextStream();
    s1.respond({
      stopReason: "tool_use",
      text: "assistant text",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: "t1" as ToolRequestId,
            toolName: "get_files" as ToolName,
            input: { files: [{ filePath: "/tool/input/path" }] },
          },
        },
      ],
    });
    const s2 = await h.nextStream();
    s2.respond({ stopReason: "end_turn", text: "done", toolRequests: [] });
    await done;
    const scanned = () => h.host.watchers.scanCalls.flatMap((c) => c.texts);
    await pollUntil(() => {
      const all = scanned();
      expect(all).toContain("user line1\nline2");
      expect(all).toContain("assistant text");
      expect(all).toContain("/tool/input/path");
      expect(
        all.some(
          (t) => t.includes("/tool/input/path") && t !== "/tool/input/path",
        ),
      ).toBe(true);
    });
    expect(scanned().some((t) => t.includes("# System Information"))).toBe(
      false,
    );
  }));

it("an untracked key stays untracked when a later scan returns it", () =>
  withGh(async (h) => {
    h.host.watchers.push("gh", active("a\n"));
    const { thread } = await h.createRoot();
    await mention(h, thread);
    expect(h.host.watchers.connections.some((c) => !c.closed)).toBe(true);
    thread.untrackWatchedResource({ watcher: "gh" as WatcherName, key: KEY });
    await pollUntil(() => {
      if (h.host.watchers.connections.some((c) => !c.closed))
        throw new Error("connection still open after untrack");
    });
    const before = h.host.watchers.scanCalls.length;
    await exchange(h, thread, `again https://github.com/${KEY}`);
    await pollUntil(() => {
      if (h.host.watchers.scanCalls.length === before)
        throw new Error("no scan");
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(thread.watchedResources).toEqual([]);
  }));

it("closes the connection after a scan that finds nothing", () =>
  withGh(async (h) => {
    const { thread } = await h.createRoot();
    await exchange(h, thread, "nothing to watch");
    await pollUntil(() => {
      const conns = h.host.watchers.connections;
      if (!conns.length || conns.some((c) => !c.closed))
        throw new Error("connection still open");
    });
  }));

it("keeps the connection open while a scan is in flight or a key is subscribed", () =>
  withGh(async (h) => {
    const first = new Defer<string[]>();
    const second = new Defer<string[]>();
    const pending = [first, second];
    h.host.watchers.scanners.set(GH, () => {
      const d = pending.shift();
      return d ? d.promise : [];
    });
    const { thread } = await h.createRoot();
    await exchange(h, thread, "one");
    await pollUntil(() => expect(pending).toEqual([]));
    const conns = h.host.watchers.connections;
    first.resolve([]);
    await new Promise((r) => setTimeout(r, 20));
    expect(conns.some((c) => !c.closed)).toBe(true);
    h.host.watchers.push("gh", active("a\n"));
    second.resolve([KEY]);
    await pollUntil(() => {
      if (thread.watchedResources[0]?.state?.status !== "active")
        throw new Error("not subscribed yet");
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(conns.some((c) => !c.closed)).toBe(true);
  }));
it("forks diff against the blob seen at the fork point", () =>
  withGh(async (h) => {
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
  withGh(async (h) => {
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

const REPO = "/project";
function withRepoScan(fn: (h: Harness) => Promise<void>) {
  return withHarness(opts, (h) => {
    h.host.watchers.scanners.set(GH, (texts) =>
      texts.includes(REPO) ? [REPO] : [],
    );
    h.host.watchers.push("gh", { ...active("repo\n"), key: REPO });
    return fn(h);
  });
}
const projectScans = (h: Harness) =>
  h.host.watchers.scanCalls.filter(
    (c) => c.texts.length === 1 && c.texts[0] === REPO,
  ).length;

it("a fresh thread scans its project dir before any message", () =>
  withRepoScan(async (h) => {
    const { thread } = await h.createRoot();
    await pollUntil(() =>
      expect(thread.watchedResources.map((r) => r.key)).toEqual([REPO]),
    );
    expect(projectScans(h)).toBe(1);
  }));

it("forks and rewinds don't rescan the project dir", () =>
  withRepoScan(async (h) => {
    const { id, thread } = await h.createRoot();
    await pollUntil(() => expect(projectScans(h)).toBe(1));
    await exchange(h, thread, "hi");
    const fork = h.thread(
      await created(h.session.forkThread(id, thread.nativeMessageIdx)),
    );
    await pollUntil(() =>
      expect(fork.watchedResources.map((r) => r.key)).toEqual([REPO]),
    );
    await thread.rewind(1 as NativeMessageIdx);
    await new Promise((r) => setTimeout(r, 20));
    expect(projectScans(h)).toBe(1);
  }));

it("compaction keeps an untracked project repo untracked", () =>
  withRepoScan(async (h) => {
    const { id, thread } = await h.createRoot();
    await pollUntil(() =>
      expect(thread.watchedResources.map((r) => r.key)).toEqual([REPO]),
    );
    thread.untrackWatchedResource({ watcher: GH, key: REPO });
    await exchange(h, thread, "hi");
    const done = h.send(thread, "@compact");
    await pollUntil(() => {
      if (!compactorOf(h, id).current) throw new Error("not compacting");
    });
    const tool = (id: string, toolName: string, input: unknown) => ({
      status: "ok" as const,
      value: { id: id as ToolRequestId, toolName: toolName as ToolName, input },
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
    after.respond({ stopReason: "end_turn", text: "ok", toolRequests: [] });
    await done;
    await new Promise((r) => setTimeout(r, 20));
    expect(projectScans(h)).toBe(1);
    expect(thread.watchedResources).toEqual([]);
  }));

it("dormancy unsubscribes; attention resubscribes and injects one diff", () =>
  withGh(async (h) => {
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
  withGh(async (h) => {
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
    await vi.advanceTimersByTimeAsync(1_500);
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
    await vi.advanceTimersByTimeAsync(1_500);
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
    await vi.advanceTimersByTimeAsync(1_500);
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
it("protocol thread state carries watched resources and untracks by ref", () =>
  withGh(async (h) => {
    h.host.watchers.push("gh", active("state: open\n"));
    const server = createInProcessServer({ session: h.session });
    const { id, thread } = await h.createRoot();
    const seen: (ProtocolThreadState | undefined)[] = [];
    server.subscribe({ type: "thread", threadId: id }, (s) => seen.push(s));
    await mention(h, thread);
    await pollUntil(() => {
      if (seen.at(-1)?.watchedResources.length !== 1)
        throw new Error("no resource");
    });
    expect(seen.at(-1)?.watchedResources).toEqual([
      {
        watcher: "gh",
        key: KEY,
        state: active("state: open\n"),
        paused: false,
        pendingUpdate: true,
      },
    ]);
    await server.execute({
      type: "thread.untrackWatchedResource",
      threadId: id,
      ref: { watcher: "gh" as WatcherName, key: KEY },
    });
    await pollUntil(() => {
      if (seen.at(-1)?.watchedResources.length !== 0)
        throw new Error("still tracked");
    });
    expect(h.host.watchers.subscriberCount("gh", KEY)).toBe(0);
    await server.dispose();
  }));
