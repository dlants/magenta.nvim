// biome-ignore-all lint/complexity/useLiteralKeys: White-box lifecycle tests deliberately access private implementation state.
import { describe, expect, it } from "vitest";
import type { ThreadId, ThreadType } from "../chat-types.ts";
import { ABORT_MARKER_TEXT } from "../providers/inference-shared.ts";
import type {
  AgentInput,
  NativeMessageIdx,
  ProviderMessage,
} from "../providers/provider-types.ts";
import { pendingMessage } from "../submission/index.ts";
import {
  awaitNextStream,
  compactorSlot,
  compactResolved,
  createAgentWithMock,
  resetThread,
  sendResolved,
  uniqueThreadId,
} from "../test-helpers.ts";
import type { ToolName, ToolRequestId } from "../tool-types.ts";
import { Defer } from "../utils/async.ts";
import { TokenBudget } from "./token-budget.ts";

const idx = 0 as NativeMessageIdx;

import type { InMemoryFileIO } from "../edl/in-memory-file-io.ts";
import { ThreadCompactor } from "./compactor.ts";
import type { CompactionOutcome } from "./index.ts";

describe("compaction submission ownership", () => {
  it("settles a busy turn before taking the compaction snapshot", async () => {
    const { core: thread, mockClient } = createAgentWithMock({
      resolve: async () => compactResolved([]),
    });
    const previous = thread.submit({
      type: "resolved",
      messages: [
        {
          type: "text",
          text: "work",
        },
      ],
    });
    const stream = await mockClient.awaitStream();
    stream.streamText("partial response");

    let snapshots = 0;
    compactorSlot(thread).compactor = {
      run: async (messages) => {
        snapshots++;
        expect(thread.isBusy).toBe(true);
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
      toolLoopSupervisors: [
        {
          hasPendingContent: () => {
            entered.resolve();
            return probe.promise;
          },
        },
      ],
      resolve: async () => compactResolved([]),
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
    expect(thread.state).toMatchObject({ type: "running" });
    await thread.abort();
    probe.resolve(true);
    expect(await previous).toEqual({ type: "aborted" });
    expect(await sent).toEqual({ type: "aborted" });
    expect(mockClient.streams).toHaveLength(0);
    await thread.destroy();
  });

  it("does not continue when reset disposal is interrupted", async () => {
    const { core: thread, mockClient } = createAgentWithMock({
      resolve: async () =>
        compactResolved([
          {
            type: "text",
            text: "continue",
          },
        ]),
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
    compactorSlot(thread).compactor = {
      run: async (_messages, next) => ({
        type: "complete",
        summary: { text: "summary", chunkCount: 1 },
        next: [...next],
      }),
    };

    expect(
      await thread.submit({
        type: "raw",
        message: pendingMessage("@compact"),
      }),
    ).toEqual({ type: "aborted" });
    expect(thread["core"]).not.toBe(original);
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
        resolve: async () =>
          compactResolved([
            {
              type: "text",
              text: "continue",
            },
          ]),
        threadType: "subagent" as ThreadType,
        yieldSchema: schema,
      },
      uniqueThreadId("compact-yield"),
    );
    const originalResult = thread.result;
    const originalCore = thread["core"];
    compactorSlot(thread).compactor = {
      run: async (_messages, next) => ({
        type: "complete",
        summary: { text: "work so far", chunkCount: 1 },
        next: [...next],
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
        resolve: async () =>
          compactResolved([
            {
              type: "text",
              text: "continue",
            },
          ]),
      },
      uniqueThreadId("stale-compact"),
    );
    const entered = new Defer<void>();
    const outcome = new Defer<CompactionOutcome>();
    compactorSlot(thread).compactor = {
      run: (_messages, _next) => {
        entered.resolve();
        return outcome.promise;
      },
    };

    const sent = thread.submit({
      type: "raw",
      message: pendingMessage("@compact"),
    });
    await entered.promise;
    // The compaction run is joined, so the action settles only once the run
    // has; the run ignores its signal and completes with a stale summary.
    const acting =
      action === "reset"
        ? resetThread(thread, { archive: { type: "none" } })
        : action === "abort"
          ? thread.abort()
          : thread.destroy();
    outcome.resolve({
      type: "complete",
      summary: { text: "stale", chunkCount: 1 },
      next: [],
    });
    await acting;
    const replacement = thread["core"];
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
    // abortSignal; driving the compactor directly, the test owns that abortSignal.
    const cancellation = new AbortController();
    const run = compactor.run(
      [
        {
          role: "user",
          content: [
            {
              nativeMessageIdx: idx,
              type: "text",
              text: "history",
            },
          ],
        },
        {
          role: "assistant" as const,
          content: [
            { type: "text" as const, text: "ok", nativeMessageIdx: idx },
          ],
        },
      ],
      [],
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
  const childResult = new Defer<import("../thread-api.ts").ThreadOutcome>();
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
          nativeMessageIdx: idx,
        },
      ],
    },
    {
      role: "assistant" as const,
      content: [{ type: "text" as const, text: "ok", nativeMessageIdx: idx }],
    },
  ];
  const compactor = new ThreadCompactor({
    parentThreadId: thread.id,
    threadManager: thread["context"].threadManager,
  });
  const cancellation = new AbortController();
  const first = compactor.run(messages, [], cancellation.signal);
  const second = compactor.run(messages, [], cancellation.signal);
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
  const childResult = new Defer<import("../thread-api.ts").ThreadOutcome>();
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
            nativeMessageIdx: idx,
            type: "text",
            text: "history",
          },
        ],
      },
      {
        role: "assistant" as const,
        content: [{ type: "text" as const, text: "ok", nativeMessageIdx: idx }],
      },
    ],
    [],
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
          ? Promise.resolve(
              compactResolved([
                {
                  type: "text",
                  text: "continue",
                },
              ]),
            )
          : resolution.promise,
    },
    uniqueThreadId("compact-submit"),
  );
  compactorSlot(thread).compactor = {
    run: (_messages, _next) => {
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
  outcome.resolve({
    type: "complete",
    summary: { text: "stale", chunkCount: 1 },
    next: [],
  });
  expect(await sent).toEqual({ type: "aborted" });
  expect(mockClient.streams).toHaveLength(0);
  await thread.abort();
  resolution.resolve(sendResolved([]));
  expect(await next).toEqual({ type: "aborted" });
  await thread.destroy();
});

describe("complete submission ownership", () => {
  const text = (value: string) => ({
    type: "text" as const,
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
        compaction: {
          compactor: {
            run: (_messages, _prompt, abortSignal) => {
              entered.resolve(abortSignal);
              return summary.promise;
            },
          },
        },
      },
      uniqueThreadId("deferred-during-compaction"),
      async (message) => {
        resolutions.push(message);
        return message === "@compact"
          ? compactResolved(message === "@compact" ? [] : [text(message)])
          : sendResolved(message === "@compact" ? [] : [text(message)]);
      },
    );
    const sent = thread.submit({
      type: "raw",
      message: pendingMessage("@compact"),
    });
    const abortSignal = await entered.promise;
    expect(thread.state).toMatchObject({
      type: "running",
      activity: { type: "preparing" },
    });
    thread.enqueue(
      { type: "raw", message: pendingMessage("deferred raw") },
      delivery,
    );
    const image = {
      type: "image" as const,
      source: {
        type: "base64" as const,
        media_type: "image/png" as const,
        data: "aW1hZ2U=",
      },
    };
    const document = {
      type: "document" as const,
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
    expect(abortSignal.aborted).toBe(false);
    expect(resolutions).toEqual(["@compact"]);
    summary.resolve({
      type: "complete",
      summary: { text: "the summary", chunkCount: 1 },
      next: [],
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
        compaction: {
          compactor: {
            run: async (_messages, next) => ({
              type: "complete",
              summary: { text: "old summary", chunkCount: 1 },
              next: [...next],
            }),
          },
        },
      },
      uniqueThreadId("preempt-reset"),
      async (message) =>
        message === "@compact"
          ? compactResolved([text(message)])
          : sendResolved([text(message)]),
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
    let handed: AgentInput[] = [];
    const { core: thread, mockClient } = createAgentWithMock(
      {
        compaction: {
          compactor: {
            run: (_messages, next) => {
              handed = [...next];
              entered.resolve();
              return outcome.promise;
            },
          },
          tokenBudget: TokenBudget.create({
            threshold: 100,
            handoff: "resume retry",
          }),
        },
      },
      uniqueThreadId("retry-compaction"),
      async (message) => {
        resolutions++;
        return sendResolved([text(message)]);
      },
    );
    const first = thread.submit({
      type: "raw",
      message: pendingMessage("original content"),
    });
    const stream = await mockClient.awaitStream();
    stream.respondWithError(new Error("request failed"));
    expect((await first).type).toBe("failed");
    mockClient.mockInputTokenCountOnce = 200;

    const retry = thread.retry();
    await entered.promise;
    expect(resolutions).toBe(1);
    expect(
      thread
        .getProviderMessages()
        .flatMap((m) => m.content)
        .filter((c) => c.type === "text" && c.text === "original content"),
    ).toHaveLength(1);
    const aborting = cancel ? thread.abort() : undefined;
    outcome.resolve({
      type: "complete",
      summary: { text: "retried history", chunkCount: 1 },
      next: handed,
    });
    await aborting;
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
        compaction: {
          compactor,
          tokenBudget: TokenBudget.create({ threshold: 100, handoff: "" }),
        },
        threadManager,
      },
      id,
    );

    // The compaction needs answered history: an unanswered trailing user
    // message is carried forward as the next prompt, not compacted.
    const first = thread.submit({
      type: "resolved",
      messages: [text("history")],
    });
    const firstStream = await mockClient.awaitStream();
    firstStream.streamText("answer");
    firstStream.finishResponse("end_turn");
    await first;
    mockClient.mockInputTokenCountOnce = 200;

    const sent = thread.submit({
      type: "resolved",
      messages: [text("pending")],
    });
    await spawning.promise;
    let replacement: ReturnType<typeof thread.submit> | undefined;
    // The spawn cannot be interrupted, and the run that owns it is joined:
    // the action settles once the late child has been cleaned up.
    const acting =
      action === "abort"
        ? thread.abort()
        : action === "destroy"
          ? thread.destroy()
          : undefined;
    if (action === "supersede")
      replacement = thread.submit({
        type: "resolved",
        messages: [text("replacement")],
      });
    const child = "late-public-child" as ThreadId;
    spawn.resolve(child);
    await acting;
    expect(await sent).toEqual({ type: "aborted" });
    expect(deleted).toEqual([child]);
    if (replacement) {
      const stream = await awaitNextStream(mockClient, firstStream);
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
describe("submission-owned compaction abortSignal", () => {
  const text = (value: string) => ({
    type: "text" as const,
    text: value,
  });
  const startCompactingThread = (id: string) => {
    const entered = new Defer<void>();
    const outcome = new Defer<CompactionOutcome>();
    let abortSignal: AbortSignal | undefined;
    const { core: thread, mockClient } = createAgentWithMock(
      {
        compaction: {
          compactor: {
            run: (_messages, _prompt, runSignal) => {
              abortSignal = runSignal;
              entered.resolve();
              return outcome.promise;
            },
          },
          tokenBudget: TokenBudget.create({ threshold: 100, handoff: "" }),
        },
      },
      uniqueThreadId(id),
    );
    mockClient.mockInputTokenCountOnce = 200;
    const sent = thread.submit({
      type: "resolved",
      messages: [text("history")],
    });
    return {
      thread,
      sent,
      entered,
      outcome,
      signalOf: () => abortSignal,
    };
  };
  it("abort cancels the abortSignal handed to the compactor", async () => {
    const { thread, sent, entered, outcome, signalOf } = startCompactingThread(
      "compaction-abortSignal-abort",
    );
    await entered.promise;
    expect(signalOf()?.aborted).toBe(false);
    const aborting = thread.abort();
    expect(signalOf()?.aborted).toBe(true);
    outcome.resolve({ type: "aborted" });
    await aborting;
    expect(await sent).toEqual({ type: "aborted" });
    expect(thread.isBusy).toBe(false);
    await thread.destroy();
  });
  it("a reset during compaction cancels it and leaves the thread at rest", async () => {
    const { thread, sent, entered, outcome, signalOf } = startCompactingThread(
      "compaction-abortSignal-reset",
    );
    await entered.promise;
    await resetThread(thread, { archive: { type: "none" } });
    outcome.resolve({ type: "aborted" });
    expect(signalOf()?.aborted).toBe(true);
    expect(await sent).toEqual({ type: "aborted" });
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

describe("ThreadCompactor pending turn split", () => {
  const user = (content: unknown[]): ProviderMessage =>
    ({ role: "user", content }) as ProviderMessage;
  const assistant = {
    role: "assistant",
    content: [{ type: "text", text: "answer" }],
  } as ProviderMessage;
  const image = {
    type: "image",
    source: { type: "base64", media_type: "image/png", data: "IMG" },
  } as const;
  const handoff = { type: "text", text: "handoff" } as const;
  async function runSplit(messages: ProviderMessage[]) {
    const prompts: string[] = [];
    const compactor = new ThreadCompactor({
      parentThreadId: uniqueThreadId("compact-split"),
      threadManager: {
        spawnThread: async (opts) => {
          prompts.push(
            (opts.fileIO as InMemoryFileIO).getFileContents("/chunk.md") ?? "",
          );
          opts.fileIO?.writeFile("/summary.md", "S");
          return uniqueThreadId("chunk") as ThreadId;
        },
        deleteThread: () => {},
        awaitThreadResult: async () =>
          ({
            type: "ok",
            value: { type: "text", text: "" },
          }) as never,
      },
    });
    const outcome = await compactor.run(
      messages,
      [handoff],
      new AbortController().signal,
    );
    return { outcome, prompts };
  }

  it("chunks everything when the log ends in an assistant turn", async () => {
    const { outcome, prompts } = await runSplit([
      user([{ type: "text", text: "question" }]),
      assistant,
    ]);
    expect(outcome).toMatchObject({ type: "complete", next: [handoff] });
    expect(prompts[0]).toContain("question");
  });

  it("carries a trailing user turn's text and image, dropping context", async () => {
    const { outcome, prompts } = await runSplit([
      user([{ type: "text", text: "question" }]),
      assistant,
      user([
        { type: "context_update", text: "CTX" },
        { type: "text", text: "pending" },
        image,
      ]),
    ]);
    expect(outcome).toMatchObject({
      type: "complete",
      next: [handoff, { type: "text", text: "pending" }, image],
    });
    expect(prompts[0]).not.toContain("pending");
    expect(prompts[0]).not.toContain("CTX");
  });

  it("carries consecutive trailing user messages in order", async () => {
    const { outcome, prompts } = await runSplit([
      user([{ type: "text", text: "question" }]),
      assistant,
      user([{ type: "text", text: "first" }]),
      user([image, { type: "text", text: "second" }]),
    ]);
    expect(outcome).toMatchObject({
      type: "complete",
      next: [
        handoff,
        { type: "text", text: "first" },
        image,
        { type: "text", text: "second" },
      ],
    });
    expect(prompts[0]).not.toContain("first");
    expect(prompts[0]).not.toContain("second");
  });
  it("does not split a tool_result tail", async () => {
    const { outcome } = await runSplit([
      user([{ type: "text", text: "question" }]),
      assistant,
      user([
        { type: "tool_result", id: "t", result: { status: "ok", value: [] } },
      ]),
    ]);
    expect(outcome).toMatchObject({ type: "complete", next: [handoff] });
  });

  it("carries nothing for an abort marker", async () => {
    const { outcome } = await runSplit([
      user([{ type: "text", text: "question" }]),
      assistant,
      user([{ type: "text", text: ABORT_MARKER_TEXT }]),
    ]);
    expect(outcome).toMatchObject({ type: "complete", next: [handoff] });
  });

  it("spawns nothing when the pending turn is the whole log", async () => {
    const { outcome, prompts } = await runSplit([
      user([{ type: "text", text: "only" }]),
    ]);
    expect(prompts).toHaveLength(0);
    expect(outcome).toEqual({
      type: "carried",
      next: [handoff, { type: "text", text: "only" }],
    });
  });
});

describe("ThreadCompactor chunk prompt", () => {
  it("names non-text handoff input with placeholders", async () => {
    const prompts: string[] = [];
    const compactor = new ThreadCompactor({
      parentThreadId: uniqueThreadId("compact-placeholder"),
      threadManager: {
        spawnThread: async (opts) => {
          prompts.push(opts.prompt);
          throw new Error("stop after spawn");
        },
        deleteThread: () => {},
        awaitThreadResult: async () => {
          throw new Error("unreachable");
        },
      },
    });
    await compactor
      .run(
        [
          {
            role: "user",
            content: [{ nativeMessageIdx: idx, type: "text", text: "history" }],
          },
          {
            role: "assistant" as const,
            content: [
              { type: "text" as const, text: "ok", nativeMessageIdx: idx },
            ],
          },
        ],
        [
          { type: "text", text: "look at this" },
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: "AAAA" },
          },
          {
            type: "document",
            source: {
              type: "base64",
              media_type: "application/pdf",
              data: "BBBB",
            },
            title: "spec.pdf",
          },
        ],
        new AbortController().signal,
      )
      .catch(() => undefined);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("look at this\n[image]\n[document: spec.pdf]");
    expect(prompts[0]).not.toContain("AAAA");
  });
});
