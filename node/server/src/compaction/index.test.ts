// biome-ignore-all lint/complexity/useLiteralKeys: White-box lifecycle tests deliberately access private implementation state.
import { describe, expect, it } from "vitest";
import type { ThreadId, ThreadType } from "../chat-types.ts";
import { PLACEHOLDER_NATIVE_MESSAGE_IDX } from "../providers/provider-types.ts";
import { pendingMessage } from "../submission/index.ts";
import {
  awaitNextStream,
  createAgentWithMock,
  resetThread,
  uniqueThreadId,
} from "../test-helpers.ts";
import type { ToolName, ToolRequestId } from "../tool-types.ts";
import { Defer } from "../utils/async.ts";
import { ThreadCompactor } from "./compactor.ts";
import type { CompactionOutcome } from "./index.ts";

describe("compaction submission ownership", () => {
  it("settles a busy turn before taking the compaction snapshot", async () => {
    const { core: thread, mockClient } = createAgentWithMock({
      resolve: async () => ({
        compact: true,
        messages: [],
        reminders: [],
      }),
    });
    const previous = thread.submit({
      type: "resolved",
      messages: [
        {
          type: "text",
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
          text: "work",
        },
      ],
    });
    const stream = await mockClient.awaitStream();
    stream.streamText("partial response");

    let snapshots = 0;
    thread["context"].compactor = {
      run: async (messages) => {
        snapshots++;
        expect(thread.isBusy).toBe(true);
        expect(thread["core"].isActive).toBe(true);
        expect(await previous).toEqual({ type: "aborted" });
        const snapshot = JSON.stringify(messages);
        await Promise.resolve();
        expect(JSON.stringify(thread.getProviderMessages())).toBe(snapshot);
        return { type: "aborted" };
      },
    };
    const sent = thread.submit({
      type: "raw",
      message: pendingMessage("@compact"),
    });
    expect(await sent).toEqual({ type: "aborted" });
    expect(snapshots).toBe(1);
    expect(mockClient.streams).toHaveLength(1);
    await thread.destroy();
  });

  it("cancels a busy compaction while the old loop is settling", async () => {
    const { core: thread, mockClient } = createAgentWithMock({
      chatSupervisors: [
        {
          hasPendingContent: () => {
            entered.resolve();
            return probe.promise;
          },
        },
      ],
      resolve: async () => ({
        compact: true,
        messages: [],
        reminders: [],
      }),
    });
    const entered = new Defer<void>();
    const probe = new Defer<boolean>();

    const previous = thread.submit({ type: "resolved", messages: [] });
    await entered.promise;

    const sent = thread.submit({
      type: "raw",
      message: pendingMessage("@compact"),
    });
    await Promise.resolve();
    expect(thread.loopState).toMatchObject({ type: "running" });
    await thread.abort();
    probe.resolve(true);
    expect(await previous).toEqual({ type: "aborted" });
    expect(await sent).toEqual({ type: "aborted" });
    expect(thread["core"].isActive).toBe(true);
    expect(mockClient.streams).toHaveLength(0);
    await thread.destroy();
  });

  it("does not continue when reset disposal is interrupted", async () => {
    const { core: thread, mockClient } = createAgentWithMock({
      resolve: async () => ({
        compact: true,
        messages: [
          {
            type: "text",
            nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
            text: "continue",
          },
        ],
        reminders: [],
      }),
    });
    const original = thread["core"];
    const dispose = original.dispose.bind(original);
    const disposing = new Defer<void>();
    const released = new Defer<void>();
    original.dispose = async () => {
      await dispose();
      disposing.resolve();
      await released.promise;
    };
    // The abort lands while the replacement is mid-disposal: it cannot be
    // issued from inside the disposal itself, which would be the submission
    // waiting for its own unwind.
    void disposing.promise.then(async () => {
      const aborted = thread.abort();
      released.resolve();
      await aborted;
    });
    thread["context"].compactor = {
      run: async () => ({
        type: "complete",
        summary: "summary",
        chunkCount: 1,
      }),
    };

    expect(
      await thread.submit({
        type: "raw",
        message: pendingMessage("@compact"),
      }),
    ).toEqual({ type: "aborted" });
    expect(thread["core"]).not.toBe(original);
    expect(thread["core"].isActive).toBe(true);
    expect(mockClient.streams).toHaveLength(0);
    await thread.destroy();
  });

  it("yields to the original result promise using the original schema after compaction", async () => {
    const schema = {
      type: "object" as const,
      properties: { answer: { type: "integer" as const } },
      required: ["answer"],
      additionalProperties: false,
    };
    const { core: thread, mockClient } = createAgentWithMock(
      {
        resolve: async () => ({
          compact: true,
          messages: [
            {
              type: "text",
              nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
              text: "continue",
            },
          ],
          reminders: [],
        }),
        threadType: "subagent" as ThreadType,
        yieldSchema: schema,
      },
      uniqueThreadId("compact-yield"),
    );
    const originalResult = thread.result;
    const originalCore = thread["core"];
    thread["context"].compactor = {
      run: async () => ({
        type: "complete",
        summary: "work so far",
        chunkCount: 1,
      }),
    };

    const sent = thread.submit({
      type: "raw",
      message: pendingMessage("@compact"),
    });
    const stream = await mockClient.awaitStream();
    expect(thread["core"]).not.toBe(originalCore);
    expect(thread.result).toBe(originalResult);
    const yieldTool = thread["core"].toolSpecs.find(
      (tool) => tool.name === "yield_to_parent",
    );
    expect(yieldTool?.input_schema).toEqual(schema);
    stream.streamToolUse(
      "compact-yield" as ToolRequestId,
      "yield_to_parent" as ToolName,
      { answer: 42 },
    );
    stream.finishResponse("end_turn");
    const expected = {
      type: "yielded",
      value: { answer: 42 },
    };
    expect(await sent).toEqual(expected);
    expect(await originalResult).toEqual(expected);
    await thread.destroy();
  });

  it.each([
    "reset",
    "destroy",
    "abort",
  ] as const)("does not apply a stale summary after %s", async (action) => {
    const { core: thread, mockClient } = createAgentWithMock(
      {
        resolve: async () => ({
          compact: true,
          messages: [
            {
              type: "text",
              nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
              text: "continue",
            },
          ],
          reminders: [],
        }),
      },
      uniqueThreadId("stale-compact"),
    );
    const entered = new Defer<void>();
    const outcome = new Defer<CompactionOutcome>();
    thread["context"].compactor = {
      run: () => {
        entered.resolve();
        return outcome.promise;
      },
    };

    const sent = thread.submit({
      type: "raw",
      message: pendingMessage("@compact"),
    });
    await entered.promise;
    if (action === "reset")
      await resetThread(thread, { archive: { type: "none" } });
    else if (action === "abort") await thread.abort();
    else await thread.destroy();
    const replacement = thread["core"];
    outcome.resolve({ type: "complete", summary: "stale", chunkCount: 1 });
    expect(await sent).toEqual({ type: "aborted" });
    expect(thread["core"]).toBe(replacement);
    expect(mockClient.streams).toHaveLength(0);
    await thread.destroy();
  });
});

describe("ThreadCompactor cancellation", () => {
  it.each([
    "discard",
    "destroy",
    "abort",
    "reset",
  ] as const)("cleans up a child whose first spawn settles after %s", async (action) => {
    const spawn = new Defer<ThreadId>();
    const spawned = new Defer<void>();
    const deleted: ThreadId[] = [];
    const { core: thread } = createAgentWithMock(
      {
        threadManager: {
          spawnThread: () => {
            spawned.resolve();
            return spawn.promise;
          },
          deleteThread: (id) => {
            deleted.push(id);
          },
          awaitThreadResult: () => {
            throw new Error("cancelled child must not be awaited");
          },
        },
      },
      uniqueThreadId("compact-spawn-race"),
    );
    const compactor = new ThreadCompactor({
      parentThreadId: thread.id,
      threadManager: thread["context"].threadManager,
    });
    // A submission's compaction is cancelled through the submission's own
    // signal; driving the compactor directly, the test owns that signal.
    const cancellation = new AbortController();
    const run = compactor.run(
      [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "history",
              nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
            },
          ],
        },
      ],
      undefined,
      cancellation.signal,
    );
    await spawned.promise;
    if (action === "discard") compactor.discard();
    else if (action === "abort") await thread.abort();
    else if (action === "reset")
      await resetThread(thread, { archive: { type: "none" } });
    else await thread.destroy();
    if (action !== "discard") cancellation.abort();
    const child = "late-child" as ThreadId;
    spawn.resolve(child);
    expect(await run).toEqual({ type: "aborted" });
    expect(deleted).toEqual([child]);
    expect(compactor.current).toBeUndefined();
    await thread.destroy();
  });
});

it("a late first spawn cannot overwrite a newer compaction", async () => {
  const firstSpawn = new Defer<ThreadId>();
  const childResult = new Defer<import("../thread-api.ts").ThreadResult>();
  const deleted: ThreadId[] = [];
  let spawnCount = 0;
  const newerChild = "newer-child" as ThreadId;
  const { core: thread } = createAgentWithMock(
    {
      threadManager: {
        spawnThread: async () =>
          ++spawnCount === 1 ? firstSpawn.promise : newerChild,
        deleteThread: (id) => {
          deleted.push(id);
          if (id === newerChild)
            childResult.resolve({ type: "aborted", reason: "deleted" });
        },
        awaitThreadResult: () => childResult.promise,
      },
    },
    uniqueThreadId("compact-spawn-superseded"),
  );
  const messages = [
    {
      role: "user" as const,
      content: [
        {
          type: "text" as const,
          text: "history",
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
        },
      ],
    },
  ];
  const compactor = new ThreadCompactor({
    parentThreadId: thread.id,
    threadManager: thread["context"].threadManager,
  });
  const cancellation = new AbortController();
  const first = compactor.run(messages, undefined, cancellation.signal);
  const second = compactor.run(messages, undefined, cancellation.signal);
  await Promise.resolve();
  const newer = compactor.current;
  expect(newer?.activeThreadId).toBe(newerChild);
  const oldChild = "old-child" as ThreadId;
  firstSpawn.resolve(oldChild);
  expect(await first).toEqual({ type: "aborted" });
  expect(compactor.current).toBe(newer);
  expect(deleted).toEqual([oldChild]);
  compactor.discard();
  await second;
  await thread.destroy();
});

it.each([
  "destroy",
  "abort",
  "reset",
  "destroy-after-yield",
] as const)("%s deletes the compactor child and settles a parked run", async (action) => {
  const childResult = new Defer<import("../thread-api.ts").ThreadResult>();
  const waiting = new Defer<void>();
  const deleted: ThreadId[] = [];
  const child = "parked-child" as ThreadId;
  const { core: thread, mockClient } = createAgentWithMock(
    {
      threadManager: {
        spawnThread: async () => child,
        deleteThread: (id) => {
          deleted.push(id);
          childResult.resolve({ type: "aborted", reason: "deleted" });
        },
        awaitThreadResult: () => {
          waiting.resolve();
          return childResult.promise;
        },
      },
    },
    uniqueThreadId("compact-parent-destroy"),
  );
  if (action === "destroy-after-yield") {
    const sent = thread.submit({
      type: "resolved",
      messages: [
        {
          type: "text",
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
          text: "yield",
        },
      ],
    });
    const stream = await mockClient.awaitStream();
    stream.streamToolUse(
      "prior-yield" as ToolRequestId,
      "yield_to_parent" as ToolName,
      { result: "done" },
    );
    stream.finishResponse("end_turn");
    expect((await sent).type).toBe("yielded");
    expect((await thread.result).type).toBe("yielded");
  }
  const compactor = new ThreadCompactor({
    parentThreadId: thread.id,
    threadManager: thread["context"].threadManager,
  });
  const cancellation = new AbortController();
  const run = compactor.run(
    [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "history",
            nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
          },
        ],
      },
    ],
    undefined,
    cancellation.signal,
  );
  await waiting.promise;
  expect(thread.isBusy).toBe(false);
  if (action === "abort") await thread.abort();
  else if (action === "reset")
    await resetThread(thread, { archive: { type: "none" } });
  else await thread.destroy();
  cancellation.abort();
  expect(await run).toEqual({ type: "aborted" });
  expect(deleted).toEqual([child]);
  expect(compactor.current).toBeUndefined();
  await thread.destroy();
});

it("an immediate submission supersedes a parked compaction before resolution", async () => {
  const entered = new Defer<void>();
  const outcome = new Defer<CompactionOutcome>();
  const resolution = new Defer<
    Awaited<ReturnType<import("../submission/index.ts").ResolveSubmission>>
  >();
  const { core: thread, mockClient } = createAgentWithMock(
    {
      resolve: (message) =>
        message === "@compact"
          ? Promise.resolve({
              compact: true,
              messages: [
                {
                  type: "text",
                  nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
                  text: "continue",
                },
              ],
              reminders: [],
            })
          : resolution.promise,
    },
    uniqueThreadId("compact-submit"),
  );
  thread["context"].compactor = {
    run: () => {
      entered.resolve();
      return outcome.promise;
    },
  };

  const sent = thread.submit({
    type: "raw",
    message: pendingMessage("@compact"),
  });
  await entered.promise;

  const next = thread.submit({
    type: "raw",
    message: pendingMessage("new prompt"),
  });
  outcome.resolve({ type: "complete", summary: "stale", chunkCount: 1 });
  expect(await sent).toEqual({ type: "aborted" });
  expect(mockClient.streams).toHaveLength(0);
  await thread.abort();
  resolution.resolve({ messages: [], reminders: [], compact: false });
  expect(await next).toEqual({ type: "aborted" });
  await thread.destroy();
});

describe("complete submission ownership", () => {
  const text = (value: string) => ({
    type: "text" as const,
    nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
    text: value,
  });

  it.each([
    "async",
    "next",
  ] as const)("delivers raw and resolved %s entries once after compaction", async (delivery) => {
    const entered = new Defer<AbortSignal>();
    const summary = new Defer<CompactionOutcome>();
    const resolutions: string[] = [];
    const { core: thread, mockClient } = createAgentWithMock(
      {
        compactor: {
          run: (_messages, _prompt, signal) => {
            entered.resolve(signal);
            return summary.promise;
          },
        },
      },
      uniqueThreadId("deferred-during-compaction"),
      async (message) => {
        resolutions.push(message);
        return {
          compact: message === "@compact",
          messages: message === "@compact" ? [] : [text(message)],
          reminders: [],
        };
      },
    );
    const sent = thread.submit({
      type: "raw",
      message: pendingMessage("@compact"),
    });
    const signal = await entered.promise;
    expect(thread.loopState).toMatchObject({
      type: "running",
      activity: { type: "preparing" },
    });
    thread.enqueue(
      { type: "raw", message: pendingMessage("deferred raw") },
      delivery,
    );
    const image = {
      type: "image" as const,
      nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
      source: {
        type: "base64" as const,
        media_type: "image/png" as const,
        data: "aW1hZ2U=",
      },
    };
    const document = {
      type: "document" as const,
      nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
      source: {
        type: "base64" as const,
        media_type: "application/pdf" as const,
        data: "ZG9jdW1lbnQ=",
      },
    };
    thread.enqueue(
      {
        type: "resolved",
        messages: [text("@compact literal"), image, document],
      },
      delivery,
    );
    expect(signal.aborted).toBe(false);
    expect(resolutions).toEqual(["@compact"]);
    summary.resolve({
      type: "complete",
      summary: "the summary",
      chunkCount: 1,
    });
    let stream = await mockClient.awaitStream();
    if (delivery === "next") {
      stream.finishResponse("end_turn");
      stream = await awaitNextStream(mockClient, stream);
    }
    const content = stream
      .getProviderMessages()
      .filter((m) => m.role === "user")
      .flatMap((m) => m.content);
    expect(
      content.filter((c) => c.type === "text" && c.text === "deferred raw"),
    ).toHaveLength(1);
    expect(
      content.filter((c) => c.type === "text" && c.text === "@compact literal"),
    ).toHaveLength(1);
    expect(content).toContainEqual(
      expect.objectContaining({ type: "image", source: image.source }),
    );
    expect(content).toContainEqual(
      expect.objectContaining({ type: "document", source: document.source }),
    );
    expect(resolutions).toEqual(["@compact", "deferred raw"]);
    stream.finishResponse("end_turn");
    expect(await sent).toEqual({ type: "completed", stopReason: "end_turn" });
    expect(thread.queued.async.length + thread.queued.next.length).toBe(0);
    await thread.destroy();
  });

  it.each([
    "raw",
    "resolved",
  ] as const)("an immediate %s submission supersedes compaction during reset", async (type) => {
    const disposing = new Defer<void>();
    const release = new Defer<void>();
    const { core: thread, mockClient } = createAgentWithMock(
      {
        compactor: {
          run: async () => ({
            type: "complete",
            summary: "old summary",
            chunkCount: 1,
          }),
        },
      },
      uniqueThreadId("preempt-reset"),
      async (message) => ({
        compact: message === "@compact",
        messages: [text(message)],
        reminders: [],
      }),
    );
    const oldCore = thread["core"];
    const dispose = oldCore.dispose.bind(oldCore);
    oldCore.dispose = async () => {
      await dispose();
      disposing.resolve();
      await release.promise;
    };
    const sent = thread.submit({
      type: "raw",
      message: pendingMessage("@compact"),
    });
    await disposing.promise;
    const replacement = thread.submit(
      type === "raw"
        ? { type, message: pendingMessage("new submission") }
        : { type, messages: [text("new submission")] },
    );
    release.resolve();
    expect(await sent).toEqual({ type: "aborted" });
    const stream = await mockClient.awaitStream();
    expect(thread["core"]).not.toBe(oldCore);
    expect(thread["core"].isActive).toBe(true);
    expect(JSON.stringify(stream.messages)).toContain("new submission");
    expect(JSON.stringify(stream.messages)).not.toContain(
      "Please continue from where you left off.",
    );
    stream.finishResponse("end_turn");
    expect(await replacement).toEqual({
      type: "completed",
      stopReason: "end_turn",
    });
    expect(mockClient.streams).toHaveLength(1);
    await thread.destroy();
  });

  it.each([
    false,
    true,
  ])("retry bypasses resolution and owns its compact handoff (cancel=%s)", async (cancel) => {
    const entered = new Defer<void>();
    const outcome = new Defer<CompactionOutcome>();
    let resolutions = 0;
    let compact = false;
    const { core: thread, mockClient } = createAgentWithMock(
      {
        chatSupervisors: [
          {
            onBeforeRequest: async () => {
              if (!compact) return { type: "none" };
              compact = false;
              return {
                type: "suspend",
                reason: { kind: "compact", nextPrompt: "resume retry" },
              };
            },
          },
        ],
        compactor: {
          run: () => {
            entered.resolve();
            return outcome.promise;
          },
        },
      },
      uniqueThreadId("retry-compaction"),
      async (message) => {
        resolutions++;
        return { compact: false, messages: [text(message)], reminders: [] };
      },
    );
    const first = thread.submit({
      type: "raw",
      message: pendingMessage("original content"),
    });
    const stream = await mockClient.awaitStream();
    stream.respondWithError(new Error("request failed"));
    expect((await first).type).toBe("failed");
    compact = true;

    const retry = thread.retry();
    await entered.promise;
    expect(resolutions).toBe(1);
    expect(
      thread
        .getProviderMessages()
        .flatMap((m) => m.content)
        .filter((c) => c.type === "text" && c.text === "original content"),
    ).toHaveLength(1);
    if (cancel) await thread.abort();
    outcome.resolve({
      type: "complete",
      summary: "retried history",
      chunkCount: 1,
    });
    if (cancel) {
      expect(await retry).toEqual({ type: "aborted" });
      expect(mockClient.streams).toHaveLength(1);
    } else {
      const resumed = await awaitNextStream(mockClient, stream);
      expect(JSON.stringify(resumed.messages)).toContain("resume retry");
      resumed.finishResponse("end_turn");
      expect(await retry).toEqual({
        type: "completed",
        stopReason: "end_turn",
      });
    }
    expect(resolutions).toBe(1);
    await thread.destroy();
  });

  it.each([
    "abort",
    "destroy",
    "supersede",
  ] as const)("%s cleans up a late compact child through public submission ownership", async (action) => {
    const spawning = new Defer<void>();
    const spawn = new Defer<ThreadId>();
    const deleted: ThreadId[] = [];
    const threadManager = {
      spawnThread: () => {
        spawning.resolve();
        return spawn.promise;
      },
      deleteThread: (id: ThreadId) => {
        deleted.push(id);
      },
      awaitThreadResult: async () => {
        throw new Error("cancelled child must not be awaited");
      },
    };
    const id = uniqueThreadId("public-compact-spawn");
    const compactor = new ThreadCompactor({
      parentThreadId: id,
      threadManager,
    });
    const { core: thread, mockClient } = createAgentWithMock(
      {
        chatSupervisors: [
          {
            onBeforeRequest: async () => {
              if (!compact) return { type: "none" };
              compact = false;
              return {
                type: "suspend",
                reason: { kind: "compact", nextPrompt: undefined },
              };
            },
          },
        ],
        compactor,
        threadManager,
      },
      id,
    );
    let compact = true;

    const sent = thread.submit({
      type: "resolved",
      messages: [text("history")],
    });
    await spawning.promise;
    let replacement: ReturnType<typeof thread.submit> | undefined;
    if (action === "abort") await thread.abort();
    else if (action === "destroy") await thread.destroy();
    else
      replacement = thread.submit({
        type: "resolved",
        messages: [text("replacement")],
      });
    const child = "late-public-child" as ThreadId;
    spawn.resolve(child);
    expect(await sent).toEqual({ type: "aborted" });
    expect(deleted).toEqual([child]);
    if (replacement) {
      const stream = await mockClient.awaitStream();
      stream.finishResponse("end_turn");
      expect(await replacement).toEqual({
        type: "completed",
        stopReason: "end_turn",
      });
    }
    expect(compactor.current).toBeUndefined();
    await thread.destroy();
  });
});
describe("submission-owned compaction signal", () => {
  const text = (value: string) => ({
    type: "text" as const,
    nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
    text: value,
  });
  const startCompactingThread = (id: string) => {
    const entered = new Defer<void>();
    const outcome = new Defer<CompactionOutcome>();
    let signal: AbortSignal | undefined;
    let compact = true;
    const { core: thread } = createAgentWithMock(
      {
        chatSupervisors: [
          {
            onBeforeRequest: async () => {
              if (!compact) return { type: "none" };
              compact = false;
              return {
                type: "suspend",
                reason: { kind: "compact", nextPrompt: undefined },
              };
            },
          },
        ],
        compactor: {
          run: (_messages, _prompt, runSignal) => {
            signal = runSignal;
            entered.resolve();
            return outcome.promise;
          },
        },
      },
      uniqueThreadId(id),
    );
    const sent = thread.submit({
      type: "resolved",
      messages: [text("history")],
    });
    return {
      thread,
      sent,
      entered,
      outcome,
      signalOf: () => signal,
    };
  };
  it("abort cancels the signal handed to the compactor", async () => {
    const { thread, sent, entered, outcome, signalOf } = startCompactingThread(
      "compaction-signal-abort",
    );
    await entered.promise;
    expect(signalOf()?.aborted).toBe(false);
    await thread.abort();
    expect(signalOf()?.aborted).toBe(true);
    outcome.resolve({ type: "aborted" });
    expect(await sent).toEqual({ type: "aborted" });
    expect(thread.isBusy).toBe(false);
    await thread.destroy();
  });
  it("a reset during compaction cancels it and leaves the thread at rest", async () => {
    const { thread, sent, entered, outcome, signalOf } = startCompactingThread(
      "compaction-signal-reset",
    );
    await entered.promise;
    await resetThread(thread, { archive: { type: "none" } });
    outcome.resolve({ type: "aborted" });
    expect(signalOf()?.aborted).toBe(true);
    expect(await sent).toEqual({ type: "aborted" });
    expect(thread.isBusy).toBe(false);
    await thread.destroy();
  });
  it("comes to rest when a compact suspension has no compactor to run it", async () => {
    let compact = true;
    const { core: thread } = createAgentWithMock(
      {
        chatSupervisors: [
          {
            onBeforeRequest: async () => {
              if (!compact) return { type: "none" };
              compact = false;
              return {
                type: "suspend",
                reason: { kind: "compact", nextPrompt: undefined },
              };
            },
          },
        ],
      },
      uniqueThreadId("compaction-missing-compactor"),
    );
    const sent = thread.submit({
      type: "resolved",
      messages: [text("history")],
    });
    expect(await sent).toEqual({
      type: "suspended",
      reason: { kind: "compact", nextPrompt: undefined },
    });
    expect(thread.isBusy).toBe(false);
    await thread.destroy();
  });
  it("settles the submission as failed when compaction errors", async () => {
    const { thread, sent, entered, outcome } =
      startCompactingThread("compaction-error");
    await entered.promise;
    outcome.resolve({ type: "error", message: "summarizer exploded" });
    expect(await sent).toMatchObject({
      type: "failed",
      error: new Error("Compaction failed: summarizer exploded"),
    });
    expect(thread.isBusy).toBe(false);
    await thread.destroy();
  });
});
