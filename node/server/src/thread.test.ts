// biome-ignore-all lint/complexity/useLiteralKeys: White-box lifecycle tests deliberately access private implementation state.
import { describe, expect, it, vi } from "vitest";
import type { ThreadType } from "./chat-types.ts";
import type { Compactor } from "./compaction/index.ts";
import {
  loopActiveTools,
  loopLabel,
  loopStreamingBlock,
} from "./loop-state.ts";
import {
  type AgentInput,
  type NativeMessageIdx,
  PLACEHOLDER_NATIVE_MESSAGE_IDX,
} from "./providers/provider-types.ts";
import {
  parseCompact,
  pendingMessage,
  renderPending,
} from "./submission/index.ts";
import {
  awaitNextStream,
  cleanupArchive,
  createAgentWithMock,
  resetThread,
  uniqueThreadId,
  userTexts,
} from "./test-helpers.ts";
import { Thread, type ThreadContext, threadCloneContext } from "./thread.ts";
import type { QueuedMessage } from "./thread-api.ts";
import { injectText } from "./thread-supervisor.ts";
import type { ToolName, ToolRequestId } from "./tool-types.ts";
import { Defer, pollUntil } from "./utils/async.ts";

describe("deferred submissions", () => {
  it.each([
    "async",
    "next",
  ] as const)("preserves programmatic inputs queued for %s without resolving them", async (queue) => {
    const resolve = vi.fn();
    const { core, mockClient } = createAgentWithMock(
      undefined,
      uniqueThreadId("queued-input"),
      resolve,
    );
    core.setTitle("test");
    const sent = core.submit({
      type: "resolved",
      messages: [
        {
          type: "text",
          text: "start",
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
        },
      ],
    });
    const first = await mockClient.awaitStream();
    const inputs: AgentInput[] = [
      {
        type: "text",
        text: "@compact is literal input",
        nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
      },
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "aW1hZ2U=" },
        nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
      },
      {
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: "cGRm" },
        title: "attachment",
        nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
      },
    ];
    expect(
      await core.submit({ type: "resolved", messages: inputs }, queue),
    ).toEqual({ type: "queued" });
    first.finishResponse("end_turn");
    const next = await awaitNextStream(mockClient, first);
    expect(resolve).not.toHaveBeenCalled();
    const content = core
      .getProviderMessages()
      .flatMap((message) => message.content);
    for (const { nativeMessageIdx: _, ...input } of inputs) {
      expect(content).toContainEqual(expect.objectContaining(input));
    }
    next.finishResponse("end_turn");
    await sent;
  });

  it("resolves a queued message at delivery, not when it was queued", async () => {
    let fileContents = "before";
    const calls: string[] = [];
    const { core, mockClient } = createAgentWithMock(
      undefined,
      uniqueThreadId("deferred-resolve"),
      (message) => {
        calls.push(fileContents);
        return Promise.resolve({
          compact: false,
          messages: [
            {
              type: "text" as const,
              nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
              text: `${message} [${fileContents}]`,
            },
          ],
          reminders: [],
        });
      },
    );
    void core.submit({
      type: "resolved",
      messages: [
        {
          type: "text",
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
          text: "start",
        },
      ],
    });
    const stream = await mockClient.awaitStream();
    expect(
      await core.submit(
        { type: "raw", message: pendingMessage("look at the file") },
        "next",
      ),
    ).toEqual({ type: "queued" });
    // Nothing was resolved at queue time.
    expect(calls).toEqual([]);
    fileContents = "after";
    stream.streamText("working");
    stream.finishResponse("end_turn");
    const second = await awaitNextStream(mockClient, stream);
    expect(calls).toEqual(["after"]);
    expect(userTexts(core)).toContain("look at the file [after]");
    second.finishResponse("end_turn");
  });

  it("flushes the whole queue, in order, at one delivery point", async () => {
    const { core, mockClient } = createAgentWithMock();
    void core.submit({
      type: "resolved",
      messages: [
        {
          type: "text",
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
          text: "start",
        },
      ],
    });
    const stream = await mockClient.awaitStream();
    for (const text of ["one", "two", "three"]) {
      await core.submit(
        { type: "raw", message: pendingMessage(text) },
        "async",
      );
    }
    expect(core.queued.async).toHaveLength(3);
    stream.streamText("working");
    stream.finishResponse("end_turn");
    const second = await awaitNextStream(mockClient, stream);
    expect(core.queued.async).toEqual([]);
    const texts = userTexts(core);
    expect(texts.slice(-3)).toEqual(["one", "two", "three"]);
    second.finishResponse("end_turn");
  });

  it("drops an entry whose resolution throws, and stays usable", async () => {
    const { core, mockClient } = createAgentWithMock(
      undefined,
      uniqueThreadId("deferred-throw"),
      (message) =>
        message === "bad"
          ? Promise.reject(new Error("resolution failed"))
          : Promise.resolve({
              compact: false,
              messages: [
                {
                  type: "text" as const,
                  nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
                  text: message,
                },
              ],
              reminders: [],
            }),
    );
    void core.submit({
      type: "resolved",
      messages: [
        {
          type: "text",
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
          text: "start",
        },
      ],
    });
    const stream = await mockClient.awaitStream();
    await core.submit({ type: "raw", message: pendingMessage("bad") }, "next");
    await core.submit({ type: "raw", message: pendingMessage("good") }, "next");
    stream.streamText("working");
    stream.finishResponse("end_turn");
    const second = await awaitNextStream(mockClient, stream);
    const texts = userTexts(core);
    expect(texts).not.toContain("bad");
    expect(texts).toContain("good");
    second.finishResponse("end_turn");
    // The thread is not wedged: it still accepts and queues further work.
    await core.submit(
      { type: "raw", message: pendingMessage("later") },
      "next",
    );
  });

  it("sends a deferred submission immediately when the agent is idle", async () => {
    const { core, mockClient } = createAgentWithMock();
    // Nothing is in flight, so there is no delivery point to wait for.
    void core.submit(
      { type: "raw", message: pendingMessage("do it now") },
      "next",
    );
    const stream = await mockClient.awaitStream();
    expect(core.queued.next).toEqual([]);
    expect(userTexts(core)).toContain("do it now");
    stream.finishResponse("end_turn");
  });

  it("activates the reminders a queued entry resolves to", async () => {
    const { core, mockClient } = createAgentWithMock(
      undefined,
      uniqueThreadId("deferred-reminder"),
      (message) =>
        Promise.resolve({
          compact: false,
          messages: [
            {
              type: "text" as const,
              nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
              text: message,
            },
          ],
          reminders: ["remember the file"],
        }),
    );
    void core.submit({
      type: "resolved",
      messages: [
        {
          type: "text",
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
          text: "start",
        },
      ],
    });
    const stream = await mockClient.awaitStream();
    await core.submit(
      { type: "raw", message: pendingMessage("queued") },
      "next",
    );
    expect(core.activeReminders.has("remember the file")).toBe(false);
    stream.streamText("working");
    stream.finishResponse("end_turn");
    const second = await awaitNextStream(mockClient, stream);
    expect(core.activeReminders.has("remember the file")).toBe(true);

    const deliveredAt = core["core"].manager.getNativeMessageIdx();
    const before = await Thread.clone({
      sourceThread: core,
      newId: uniqueThreadId("deferred-reminder-before"),
      nativeMessageIdx: (deliveredAt - 1) as NativeMessageIdx,
      context: threadCloneContext(core["context"]),
      callbacks: core.callbacks,
    });
    const through = await Thread.clone({
      sourceThread: core,
      newId: uniqueThreadId("deferred-reminder-through"),
      nativeMessageIdx: deliveredAt,
      context: threadCloneContext(core["context"]),
      callbacks: core.callbacks,
    });
    expect(before.activeReminders.has("remember the file")).toBe(false);
    expect(through.activeReminders.has("remember the file")).toBe(true);

    second.finishResponse("end_turn");
    await before.destroy();
    await through.destroy();
  });

  it("still carries the standing reminder on the submission after a resting turn-end", async () => {
    const { core, mockClient } = createAgentWithMock();
    void core.submit({
      type: "resolved",
      messages: [
        {
          type: "text",
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
          text: "hello",
        },
      ],
    });
    const stream = await mockClient.awaitStream();
    stream.streamText("working");
    // Enough output tokens to arm the standing reminder. Nothing is queued, so
    // this stop issues no request; the reminder must still reach the model on
    // the next user submission.
    stream.finishResponse("end_turn", { inputTokens: 1, outputTokens: 5000 });
    await pollUntil(() => {
      if (!core.isBusy) return true;
      throw new Error("waiting for the thread to come to rest");
    });
    void core.submit({
      type: "resolved",
      messages: [
        {
          type: "text",
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
          text: "again",
        },
      ],
    });
    const second = await awaitNextStream(mockClient, stream);
    const lastMessage = second.messages[second.messages.length - 1];
    expect(JSON.stringify(lastMessage.content)).toContain("<system-reminder>");
    second.finishResponse("end_turn");
  });
  it("comes to rest when every queued entry fails to resolve", async () => {
    const { core, mockClient } = createAgentWithMock(
      undefined,
      uniqueThreadId("deferred-all-fail"),
      () => Promise.reject(new Error("resolution failed")),
    );
    const sent = core.submit({
      type: "resolved",
      messages: [
        {
          type: "text",
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
          text: "start",
        },
      ],
    });
    const stream = await mockClient.awaitStream();
    await core.submit({ type: "raw", message: pendingMessage("bad") }, "next");
    const streamsBefore = mockClient.streams.length;
    stream.finishResponse("end_turn");
    // The queue emptied into nothing, so there is no request to issue.
    expect(await sent).toEqual({ type: "completed", stopReason: "end_turn" });
    expect(mockClient.streams.length).toBe(streamsBefore);
    expect(core.queued.next).toEqual([]);
  });

  it("delivers a mid-turn queued message on the tool_use continuation", async () => {
    let resolveStat!: () => void;
    const statPromise = new Promise<{ mtimeMs: number; size: number }>(
      (resolve) => {
        resolveStat = () => resolve({ mtimeMs: 0, size: 100 });
      },
    );
    const { core, mockClient } = createAgentWithMock({
      fileIO: {
        readFile: async () => "file contents",
        writeFile: async () => {},
        fileExists: async () => true,
        stat: async () => statPromise,
      } as unknown as ThreadContext["fileIO"],
    });
    void core.submit({
      type: "resolved",
      messages: [
        {
          type: "text",
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
          text: "start",
        },
      ],
    });
    const stream = await mockClient.awaitStream();
    stream.streamToolUse(
      "tool-midturn" as ToolRequestId,
      "get_files" as ToolName,
      { files: [{ filePath: "/tmp/test.txt" }] },
    );
    stream.finishResponse("tool_use");
    await pollUntil(() => {
      if (loopLabel(core.loopState) === "running_tools") return true;
      throw new Error(`waiting for tool_use, got ${loopLabel(core.loopState)}`);
    });
    expect(
      await core.submit(
        { type: "raw", message: pendingMessage("also check this") },
        "async",
      ),
    ).toEqual({ type: "queued" });
    resolveStat();

    const continuation = await awaitNextStream(mockClient, stream);
    // The text rides the continuation, coalesced into the same user message as
    // the tool result and ordered after it.
    const lastMessage = continuation.messages[continuation.messages.length - 1];
    expect(lastMessage.role).toBe("user");
    const blocks = lastMessage.content;
    if (typeof blocks === "string") throw new Error("expected content blocks");
    const toolResultIdx = blocks.findIndex((b) => b.type === "tool_result");
    expect(toolResultIdx).toBeGreaterThanOrEqual(0);
    expect(
      blocks.findIndex(
        (b) => b.type === "text" && b.text.includes("also check this"),
      ),
    ).toBeGreaterThan(toolResultIdx);
    expect(core.queued.async).toEqual([]);
    continuation.finishResponse("end_turn");
    // Exactly once: the stop behind the continuation finds both queues empty,
    // so `flushAtStop` has nothing left to re-deliver.
    await pollUntil(() => {
      if (!core.isBusy) return true;
      throw new Error("waiting for the thread to come to rest");
    });
    expect(mockClient.streams.length).toBe(2);
    expect(
      userTexts(core).filter((t) => t.includes("also check this")).length,
    ).toBe(1);
  });

  it("does not drain the async queue into an agent-internal submission", async () => {
    const { core, mockClient } = createAgentWithMock(
      {
        chatSupervisors: [
          {
            onYield: async () => {
              if (rejected) return { type: "none" as const };
              rejected = true;
              return { type: "reject" as const, message: "not done yet" };
            },
          },
        ],
        threadType: "subagent" as ThreadType,
      },
      uniqueThreadId("deferred-yield-rejection"),
    );
    let rejected = false;

    void core.submit({
      type: "resolved",
      messages: [
        {
          type: "text",
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
          text: "do the task",
        },
      ],
    });
    const stream = await mockClient.awaitStream();
    expect(
      await core.submit(
        { type: "raw", message: pendingMessage("also check this") },
        "async",
      ),
    ).toEqual({ type: "queued" });
    stream.streamToolUse(
      "tool-yield-rejected" as ToolRequestId,
      "yield_to_parent" as ToolName,
      { result: "done" },
    );
    stream.finishResponse("end_turn");
    // The rejection is a submission the agent makes on its own behalf, and it
    // is a request like any other: the async queue rides it.
    const rejection = await awaitNextStream(mockClient, stream);
    expect(userTexts(core)).toContain("not done yet");
    expect(userTexts(core)).toContain("also check this");
    expect(core.queued.async).toEqual([]);
    rejection.finishResponse("end_turn");
  });
  it("defers an @async @compact past the request it cannot ride on", async () => {
    let resolveStat!: () => void;
    const statPromise = new Promise<{ mtimeMs: number; size: number }>(
      (resolve) => {
        resolveStat = () => resolve({ mtimeMs: 0, size: 100 });
      },
    );
    const { core, mockClient } = createAgentWithMock(
      {
        fileIO: {
          readFile: async () => "file contents",
          writeFile: async () => {},
          fileExists: async () => true,
          stat: async () => statPromise,
        } as unknown as ThreadContext["fileIO"],
      },
      uniqueThreadId("deferred-async-compact"),
      (message) => {
        const { compact, rest } = parseCompact(message);
        return Promise.resolve({
          compact,
          messages: rest.length
            ? [
                {
                  type: "text" as const,
                  nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
                  text: rest,
                },
              ]
            : [],
          reminders: [],
        });
      },
    );
    const sent = core.submit({
      type: "resolved",
      messages: [
        {
          type: "text",
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
          text: "start",
        },
      ],
    });
    const stream = await mockClient.awaitStream();
    stream.streamToolUse(
      "tool-async-compact" as ToolRequestId,
      "get_files" as ToolName,
      { files: [{ filePath: "/tmp/test.txt" }] },
    );
    stream.finishResponse("tool_use");
    await pollUntil(() => {
      if (loopLabel(core.loopState) === "running_tools") return true;
      throw new Error(`waiting for tool_use, got ${loopLabel(core.loopState)}`);
    });
    expect(
      await core.submit(
        { type: "raw", message: pendingMessage("@compact wrap it up") },
        "async",
      ),
    ).toEqual({
      type: "queued",
    });
    resolveStat();

    // There is no place to hand the transcript over from mid-turn, so the
    // request carrying the tool results goes out without it.
    const toolResultStream = await awaitNextStream(mockClient, stream);
    expect(userTexts(core)).not.toContain("wrap it up");
    expect(core.queued.next).toEqual([
      { type: "raw", message: pendingMessage("@compact wrap it up") },
    ]);

    // The next stop is the earliest point where it can take effect.
    const compact = vi.fn(async () => ({ type: "aborted" as const }));
    core["context"].compactor = { run: compact };
    toolResultStream.finishResponse("end_turn");
    expect(await sent).toEqual({ type: "aborted" });
    expect(compact).toHaveBeenCalledWith(
      expect.any(Array),
      "wrap it up",
      expect.any(AbortSignal),
    );
    expect(core.lastResult()).toEqual({ type: "aborted" });
  });

  it("folds entries ahead of a stop-time @compact in, and re-queues the rest", async () => {
    const { core, mockClient } = createAgentWithMock(
      undefined,
      uniqueThreadId("deferred-stop-compact"),
      (message) => {
        const { compact, rest } = parseCompact(message);
        return Promise.resolve({
          compact,
          messages: rest.length
            ? [
                {
                  type: "text" as const,
                  nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
                  text: rest,
                },
              ]
            : [],
          reminders: [],
        });
      },
    );
    const sent = core.submit({
      type: "resolved",
      messages: [
        {
          type: "text",
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
          text: "start",
        },
      ],
    });
    const stream = await mockClient.awaitStream();
    for (const text of ["first", "@compact wrap up", "third"]) {
      await core.submit({ type: "raw", message: pendingMessage(text) }, "next");
    }
    const compact = vi.fn(async () => ({ type: "aborted" as const }));
    core["context"].compactor = { run: compact };
    stream.finishResponse("end_turn");

    // There is no request left to carry "first", so it folds into the prompt
    // the compaction hands to the next generation.
    expect(await sent).toEqual({ type: "aborted" });
    expect(compact).toHaveBeenCalledWith(
      expect.any(Array),
      "first\nwrap up",
      expect.any(AbortSignal),
    );
    // Everything behind the compaction keeps its place in the queue.
    expect(core.queued.next).toEqual([
      { type: "raw", message: pendingMessage("third") },
    ]);
  });

  it("keeps a queue flushed for a stop-suspended request for the next request", async () => {
    const threadId = uniqueThreadId("deferred-stop-suspend");
    let requests = 0;
    let suspend = true;
    const { core, mockClient } = createAgentWithMock(
      {
        chatSupervisors: [
          {
            onBeforeRequest: () =>
              Promise.resolve(
                suspend && ++requests > 1
                  ? {
                      type: "suspend" as const,
                      reason: { kind: "stop" as const, message: "halt" },
                    }
                  : { type: "none" as const },
              ),
          },
        ],
      },
      threadId,
    );
    try {
      // Not the opening request of the send: the one the stop-time flush
      // produces.

      const first = core.submit({
        type: "resolved",
        messages: [
          {
            type: "text",
            nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
            text: "start",
          },
        ],
      });
      const stream = await mockClient.awaitStream();
      await core.submit(
        { type: "raw", message: pendingMessage("queued") },
        "next",
      );
      stream.finishResponse("end_turn");
      // The stop flushed the queue for a request the gate then refused. The
      // content is spent — it cannot be resolved again — so it is held for
      // whatever request this thread issues next.
      expect(await first).toEqual({
        type: "empty",
      });
      expect(core.queued.next).toEqual([]);
      expect(userTexts(core)).toContain("queued");
      suspend = false;
      void core.submit({
        type: "resolved",
        messages: [
          {
            type: "text",
            nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
            text: "resume",
          },
        ],
      });
      const resumed = await awaitNextStream(mockClient, stream);
      expect(userTexts(core).filter((t) => t === "queued")).toHaveLength(1);
      resumed.finishResponse("end_turn");
    } finally {
      await core.destroy();
      await cleanupArchive(threadId);
    }
  });
  it("keeps a system reminder pending across a suspended request", async () => {
    const threadId = uniqueThreadId("reminder-suspend");
    let suspend = true;
    const { core, mockClient } = createAgentWithMock(
      {
        chatSupervisors: [
          {
            onBeforeRequest: () =>
              Promise.resolve(
                suspend
                  ? {
                      type: "suspend" as const,
                      reason: { kind: "stop" as const, message: "halt" },
                    }
                  : { type: "none" as const },
              ),
          },
        ],
      },
      threadId,
    );
    try {
      expect(
        await core.submit({
          type: "resolved",
          messages: [
            {
              type: "text",
              nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
              text: "start",
            },
          ],
        }),
      ).toEqual({
        type: "empty",
      });
      // A reminder placed in a request that is never issued would be marked
      // sent and silently lost.
      expect(mockClient.streams).toHaveLength(0);
      expect(JSON.stringify(core.getProviderMessages())).not.toContain(
        "system-reminder",
      );
      suspend = false;
      void core.submit({
        type: "resolved",
        messages: [
          {
            type: "text",
            nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
            text: "resume",
          },
        ],
      });
      const stream = await mockClient.awaitStream();
      expect(JSON.stringify(stream.messages)).toContain("Remember the skills");
      stream.finishResponse("end_turn");
    } finally {
      await core.destroy();
      await cleanupArchive(threadId);
    }
  });
  it("carries a queue flushed for a suspended request onto the handoff", async () => {
    const threadId = uniqueThreadId("deferred-compact");
    const calls: string[] = [];
    let requests = 0;
    let compacted = false;
    const { core, mockClient } = createAgentWithMock(
      {
        chatSupervisors: [
          {
            onBeforeRequest: () =>
              Promise.resolve(
                !compacted && ++requests > 1
                  ? {
                      type: "suspend" as const,
                      reason: { kind: "compact", nextPrompt: undefined },
                    }
                  : { type: "none" as const },
              ),
          },
        ],
      },
      threadId,
      (message) => {
        calls.push(message);
        return Promise.resolve({
          compact: false,
          messages: [
            {
              type: "text" as const,
              nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
              text: message,
            },
          ],
          reminders: [],
        });
      },
    );
    try {
      let queueAtHandoff = -1;
      let callsAtHandoff = -1;
      const compactor: Compactor = {
        run: () => {
          compacted = true;
          queueAtHandoff = core.queued.next.length;
          callsAtHandoff = calls.length;
          return Promise.resolve({
            type: "complete",
            summary: "SUMMARY TEXT",
            chunkCount: 1,
          });
        },
      };

      core["context"].compactor = compactor;
      void core.submit({
        type: "resolved",
        messages: [
          {
            type: "text",
            nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
            text: "start",
          },
        ],
      });
      const stream = await mockClient.awaitStream();
      await core.submit(
        { type: "raw", message: pendingMessage("queued") },
        "next",
      );
      stream.finishResponse("end_turn");

      // The stop flushed the queue for the request the gate then refused to
      // issue. Resolution is not repeatable, so rather than being resolved a
      // second time the content travels on the handoff itself: it becomes the
      // compaction's follow-up prompt.
      const contStream = await awaitNextStream(mockClient, stream);
      expect(queueAtHandoff).toBe(0);
      expect(callsAtHandoff).toBe(1);
      // Delivered by the post-compaction request itself, exactly once.
      expect(userTexts(core)).toContain("queued");
      expect(calls).toEqual(["queued"]);
      expect(core.queued.next).toEqual([]);
      contStream.streamText("resumed");
      contStream.finishResponse("end_turn");
    } finally {
      await core.destroy();
      await cleanupArchive(threadId);
    }
  });
});

describe("Thread.submit while busy", () => {
  it("discards the queues when the caller sends now instead", async () => {
    const { core, mockClient } = createAgentWithMock();
    void core.submit({
      type: "resolved",
      messages: [
        {
          type: "text",
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
          text: "start",
        },
      ],
    });
    const stream = await mockClient.awaitStream();
    stream.streamText("working");
    await core.submit(
      { type: "raw", message: pendingMessage("queued async") },
      "async",
    );
    await core.submit(
      { type: "raw", message: pendingMessage("queued next") },
      "next",
    );

    // Sending now supersedes whatever was waiting on the aborted turn.
    void core.submit({
      type: "resolved",
      messages: [
        {
          type: "text",
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
          text: "never mind, do this",
        },
      ],
    });
    const second = await awaitNextStream(mockClient, stream);
    expect(core.queued.async).toEqual([]);
    expect(core.queued.next).toEqual([]);
    const texts = userTexts(core);
    expect(texts).not.toContain("queued async");
    expect(texts).not.toContain("queued next");
    expect(texts).toContain("never mind, do this");
    second.finishResponse("end_turn");
  });
});

describe("Thread aborts the tools it owns", () => {
  /** A thread mid-way through a `get_files` batch whose stat never settles on
   * its own: the invocations are live until someone aborts them. */
  async function threadWithLiveTool(
    threadId: string,
    onToolResults: () => undefined = () => undefined,
  ) {
    let resolveStat!: () => void;
    const statPromise = new Promise<{ mtimeMs: number; size: number }>(
      (resolve) => {
        resolveStat = () => resolve({ mtimeMs: 0, size: 100 });
      },
    );
    const { core, mockClient } = createAgentWithMock(
      {
        chatSupervisors: [{ onToolResults }],
        fileIO: {
          readFile: async () => "file contents",
          writeFile: async () => {},
          fileExists: async () => true,
          stat: async () => statPromise,
        } as unknown as ThreadContext["fileIO"],
      },
      uniqueThreadId(threadId),
    );

    const sent = core.submit({
      type: "resolved",
      messages: [
        {
          type: "text",
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
          text: "start",
        },
      ],
    });
    const stream = await mockClient.awaitStream();
    stream.streamToolUse("tool-1" as ToolRequestId, "get_files" as ToolName, {
      files: [{ filePath: "/tmp/test.txt" }],
    });
    stream.finishResponse("tool_use");
    const active = await pollUntil(() => {
      const tools = loopActiveTools(core.loopState);
      if (!tools?.size) throw new Error("waiting for live invocations");
      return tools;
    });
    const abortSpies = [...active.values()].map((entry) =>
      vi.spyOn(entry.handle, "abort"),
    );
    return { core, sent, abortSpies, resolveStat };
  }

  it("aborts the live invocations when the thread aborts", async () => {
    const { core, sent, abortSpies, resolveStat } =
      await threadWithLiveTool("abort-live-tool");
    const aborted = core.abort();
    for (const spy of abortSpies) expect(spy).toHaveBeenCalled();
    resolveStat();
    await aborted;
    await sent;
    expect(core.isBusy).toBe(false);
  });

  it("aborts the live invocations when the thread is destroyed", async () => {
    const { core, sent, abortSpies, resolveStat } =
      await threadWithLiveTool("destroy-live-tool");
    const destroyed = core.destroy();
    for (const spy of abortSpies) expect(spy).toHaveBeenCalled();
    resolveStat();
    await destroyed;
    await sent;
  });

  it.each([
    "abort",
    "reset",
    "destroy",
  ] as const)("reports settling tool results only for the current turn during %s", async (action) => {
    const onToolResults = vi.fn(() => undefined);
    const { core, sent, resolveStat } = await threadWithLiveTool(
      `results-during-${action}`,
      onToolResults,
    );
    const archive = core.completedTools;
    const stopping =
      action === "reset"
        ? resetThread(core, { seed: [], archive: { type: "none" } })
        : action === "destroy"
          ? core.destroy()
          : core.abort();
    resolveStat();
    await stopping;
    expect(await sent).toEqual({ type: "aborted" });
    expect(onToolResults).toHaveBeenCalledTimes(action === "abort" ? 1 : 0);
    expect(archive.size).toBe(1);
    expect(archive.get("tool-1" as ToolRequestId)).toMatchObject({
      request: {
        toolName: "get_files",
        input: { files: [{ filePath: "/tmp/test.txt" }] },
      },
      result: { result: { status: "error" } },
      structuredResult: undefined,
    });
    expect(core.completedTools).toBe(archive);
    await core.destroy();
  });

  it("keeps the activity while the abort winds the loop down", async () => {
    const { core, sent, resolveStat } = await threadWithLiveTool(
      "aborting-flag-live-tool",
    );
    const aborting = core.abort();
    // An aborting thread is still running its tools, and the view still has
    // to show that.
    expect(core.loopState).toMatchObject({
      type: "running",
      aborting: true,
      activity: { type: "running_tools" },
    });
    resolveStat();
    await aborting;
    await sent;
    expect(core.lastResult()).toEqual({ type: "aborted" });
  });
  it("does not carry the aborting flag into the superseding turn", async () => {
    const { core, sent, abortSpies, resolveStat } = await threadWithLiveTool(
      "supersede-live-tool",
    );
    const resent = core.submit({
      type: "resolved",
      messages: [
        {
          type: "text",
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
          text: "never mind, do this",
        },
      ],
    });
    for (const spy of abortSpies) expect(spy).toHaveBeenCalled();
    resolveStat();
    await sent;
    // The new loop owns a new turn, so its tools are not silently aborted.
    await pollUntil(() => {
      const state = core.loopState;
      if (state.type !== "running" || state.aborting) {
        throw new Error("waiting for a clean loop");
      }
      return state;
    });
    await core.abort();
    await resent;
  });
});

describe("Thread loop activity", () => {
  it("reports request preparation between tool batches and streaming", async () => {
    const labels: string[] = [];
    const { core, mockClient } = createAgentWithMock(
      {
        fileIO: {
          readFile: async () => "file contents",
          writeFile: async () => {},
          fileExists: async () => true,
          stat: async () => ({ mtimeMs: 0, size: 100 }),
        } as unknown as ThreadContext["fileIO"],
      },
      uniqueThreadId("loop-activity"),
      undefined,
      () => {
        const label = loopLabel(core.loopState);
        if (labels[labels.length - 1] !== label) labels.push(label);
      },
    );
    const sent = core.submit({
      type: "resolved",
      messages: [
        {
          type: "text",
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
          text: "read the file",
        },
      ],
    });
    const stream = await mockClient.awaitStream();
    stream.emitEvent({
      type: "content_block_start",
      index: stream.nextBlockIndex(),
      content_block: { type: "text", text: "looking", citations: null },
    });
    await stream.settle();
    // Nothing is rendered as a last result while the loop owns the thread.
    expect(core.lastResult()).toBeUndefined();
    // The block in flight is visible for the duration of the streaming
    // activity.
    expect(loopStreamingBlock(core.loopState)).toEqual({
      type: "text",
      text: "looking",
    });
    stream.emitEvent({ type: "content_block_stop", index: 0 });
    stream.streamToolUse("tool-1" as ToolRequestId, "get_files" as ToolName, {
      files: [{ filePath: "/tmp/test.txt" }],
    });
    stream.finishResponse("tool_use");
    const second = await awaitNextStream(mockClient, stream);
    second.finishResponse("end_turn");
    await sent;
    expect(
      labels.slice(
        labels.indexOf("preparing"),
        labels.indexOf("preparing") + 5,
      ),
    ).toEqual([
      "preparing",
      "streaming",
      "running_tools",
      "preparing",
      "streaming",
    ]);
    expect(labels[labels.length - 1]).toBe("idle");
    expect(core.lastResult()).toEqual({
      type: "completed",
      stopReason: "end_turn",
    });
  });
  it("stays running between the turns of a multi-turn loop", async () => {
    const entered = new Defer<void>();
    const gate = new Defer<void>();
    const { core, mockClient } = createAgentWithMock(
      undefined,
      uniqueThreadId("loop-between-turns"),
      async (message) => {
        entered.resolve();
        await gate.promise;
        return {
          compact: false,
          messages: [
            {
              type: "text" as const,
              nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
              text: message,
            },
          ],
          reminders: [],
        };
      },
    );
    const sent = core.submit({
      type: "resolved",
      messages: [
        {
          type: "text",
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
          text: "start",
        },
      ],
    });
    const stream = await mockClient.awaitStream();
    await core.submit(
      { type: "raw", message: pendingMessage("queued follow-up") },
      "next",
    );
    stream.streamText("ok");
    stream.finishResponse("end_turn");
    // The agent has settled, but the loop has not: it is deciding what
    // follows the stop, and the thread is still busy.
    await entered.promise;
    expect(core.loopState).toMatchObject({
      type: "running",
      activity: { type: "preparing" },
    });
    expect(core.isBusy).toBe(true);
    gate.resolve();
    const second = await awaitNextStream(mockClient, stream);
    second.finishResponse("end_turn");
    await sent;
    expect(core.loopState.type).toBe("idle");
  });
});
describe("Thread.abort between turns", () => {
  it("stops the loop instead of issuing the continuation", async () => {
    const entered = new Defer<void>();
    const gate = new Defer<void>();
    const resolved: string[] = [];
    const { core, mockClient } = createAgentWithMock(
      undefined,
      uniqueThreadId("abort-between-turns"),
      async (message) => {
        entered.resolve();
        await gate.promise;
        resolved.push(message);
        return {
          compact: false,
          messages: [
            {
              type: "text" as const,
              nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
              text: message,
            },
          ],
          reminders: ["aborted reminder"],
        };
      },
    );
    const sent = core.submit({
      type: "resolved",
      messages: [
        {
          type: "text",
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
          text: "start",
        },
      ],
    });
    const stream = await mockClient.awaitStream();
    await core.submit(
      { type: "raw", message: pendingMessage("queued follow-up") },
      "next",
    );
    stream.streamText("ok");
    stream.finishResponse("end_turn");
    // The agent has settled and has nothing in flight to interrupt; the loop
    // is between turns, preparing the continuation.
    await entered.promise;
    const streamsBefore = mockClient.streams.length;
    const aborting = core.abort();
    gate.resolve();
    // Entries the drain already resolved are discarded rather than handed
    // back: the drain got there first, so there is nothing left to report.
    expect((await aborting).unsent).toEqual([]);
    expect(resolved).toEqual(["queued follow-up"]);
    expect(await sent).toEqual({ type: "aborted" });
    expect(mockClient.streams.length).toBe(streamsBefore);
    expect(core.activeReminders.has("aborted reminder")).toBe(false);
    expect(userTexts(core)).not.toContain("queued follow-up");
    const fresh = core.submit({
      type: "resolved",
      messages: [
        {
          type: "text",
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
          text: "fresh submission",
        },
      ],
    });
    const freshStream = await awaitNextStream(mockClient, stream);
    expect(core.loopState).toMatchObject({ type: "running", aborting: false });
    freshStream.streamText("done");
    freshStream.finishResponse("end_turn");
    expect(await fresh).toEqual({ type: "completed", stopReason: "end_turn" });
  });

  it("issues no continuation when the abort races the stop", async () => {
    let onUpdate: () => void = () => {};
    const { core, mockClient } = createAgentWithMock(
      {
        chatSupervisors: [
          {
            onBeforeRequest: () => {
              if (++requests > 1) stopConsultations.push("continuation");
              return Promise.resolve({ type: "none" as const });
            },
          },
        ],
      },
      uniqueThreadId("abort-at-stop"),
      undefined,
      () => onUpdate(),
    );
    const stopConsultations: string[] = [];
    let requests = 0;

    const sent = core.submit({
      type: "resolved",
      messages: [
        {
          type: "text",
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
          text: "start",
        },
      ],
    });
    const stream = await mockClient.awaitStream();
    stream.streamText("ok");
    const streamsBefore = mockClient.streams.length;
    let aborting: Promise<unknown> | undefined;
    let aborted = false;
    // The abort lands as the turn is finishing, so it is the agent that
    // reports it — the loop must take that at face value rather than
    // treating the stop as a turn boundary to continue from.
    onUpdate = () => {
      const state = core.loopState;
      // The agent has settled and handed the thread back to the loop: the
      // window in which the loop is deciding what follows the stop.
      if (
        aborted ||
        state.type !== "running" ||
        state.activity.type !== "preparing"
      )
        return;
      aborted = true;
      aborting = core.abort();
    };
    stream.finishResponse("end_turn");
    expect(await sent).toEqual({ type: "aborted" });
    expect(aborted).toBe(true);
    await aborting;
    // No stop was ever presented to the supervisors, so nothing decided to
    // follow it.
    expect(stopConsultations).toEqual([]);
    expect(mockClient.streams.length).toBe(streamsBefore);
  });
});

describe("Thread.abort returns the unsent queue", () => {
  const queuedText = (unsent: ReadonlyArray<QueuedMessage>) =>
    unsent.map((q) => renderPending(q.message)).join("\n");

  it("drains the queue and hands it back to whoever aborted", async () => {
    const { core, mockClient } = createAgentWithMock();
    void core.submit({
      type: "resolved",
      messages: [
        {
          type: "text",
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
          text: "hello",
        },
      ],
    });
    const stream = await mockClient.awaitStream();
    stream.streamText("partial response");
    for (const text of [
      pendingMessage("queued one"),
      pendingMessage("queued two"),
    ]) {
      await core.submit({ type: "raw", message: text }, "async");
    }
    const { unsent } = await core.abort();
    expect(core.queued.async).toEqual([]);
    expect(queuedText(unsent)).toBe("queued one\nqueued two");
  });

  it("returns an empty list when nothing was queued", async () => {
    const { core, mockClient } = createAgentWithMock();
    void core.submit({
      type: "resolved",
      messages: [
        {
          type: "text",
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
          text: "hello",
        },
      ],
    });
    const stream = await mockClient.awaitStream();
    stream.streamText("partial response");
    const { unsent } = await core.abort();
    expect(unsent).toEqual([]);
    expect(core.queued.async).toEqual([]);
  });

  it("returns every queued entry; filtering is the consumer's policy", async () => {
    const { core, mockClient } = createAgentWithMock();
    void core.submit({
      type: "resolved",
      messages: [
        {
          type: "text",
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
          text: "hello",
        },
      ],
    });
    const stream = await mockClient.awaitStream();
    stream.streamText("partial response");
    for (const text of [
      pendingMessage("queued user"),
      pendingMessage("queued other"),
    ]) {
      await core.submit({ type: "raw", message: text }, "async");
    }
    const { unsent } = await core.abort();
    expect(core.queued.async).toEqual([]);
    expect(unsent).toHaveLength(2);
    expect(queuedText(unsent)).toBe("queued user\nqueued other");
  });

  it("reports the queue for a subagent thread as well", async () => {
    const { core, mockClient } = createAgentWithMock({
      threadType: "subagent" as ThreadType,
    });
    void core.submit({
      type: "resolved",
      messages: [
        {
          type: "text",
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
          text: "do the task",
        },
      ],
    });
    const stream = await mockClient.awaitStream();
    stream.streamText("partial response");
    for (const text of [pendingMessage("queued")]) {
      await core.submit({ type: "raw", message: text }, "async");
    }
    const { unsent } = await core.abort();
    expect(queuedText(unsent)).toBe("queued");
    expect(core.queued.async).toEqual([]);
  });
});

describe("system-info preamble", () => {
  /** The injection is classified on append, so it is not a plain text block. */
  const preambles = (core: Thread) =>
    core
      .getProviderMessages()
      .flatMap((m) => (typeof m.content === "string" ? [] : m.content))
      .filter((b) => b.type === "system_info").length;

  it("rides the first request only, and the first one after a reset", async () => {
    const { core, mockClient } = createAgentWithMock(
      {},
      uniqueThreadId("system-info-preamble"),
    );
    const first = core.submit({
      type: "resolved",
      messages: [
        {
          type: "text",
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
          text: "one",
        },
      ],
    });
    const stream = await mockClient.awaitStream();
    stream.finishResponse("end_turn");
    await first;
    expect(preambles(core)).toBe(1);

    const second = core.submit({
      type: "resolved",
      messages: [
        {
          type: "text",
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
          text: "two",
        },
      ],
    });
    const stream2 = await awaitNextStream(mockClient, stream);
    stream2.finishResponse("end_turn");
    await second;
    expect(preambles(core)).toBe(1);

    // The replacement agent starts from an empty log, so the preamble is due
    // again — the supervisor list survives the swap and has to be re-armed.
    await resetThread(core, { seed: [], archive: { type: "none" } });
    const third = core.submit({
      type: "resolved",
      messages: [
        {
          type: "text",
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
          text: "three",
        },
      ],
    });
    const stream3 = await awaitNextStream(mockClient, stream2);
    stream3.finishResponse("end_turn");
    await third;
    expect(preambles(core)).toBe(1);
  });
});

describe("empty send gate", () => {
  it("issues a request for an empty send when a supervisor has content", async () => {
    const { core, mockClient } = createAgentWithMock({
      chatSupervisors: [
        {
          hasPendingContent: () => Promise.resolve(true),
          onBeforeRequest: () =>
            Promise.resolve(injectText("# context update")),
        },
      ],
    });

    const sent = core.submit({ type: "resolved", messages: [] });
    const stream = await mockClient.awaitStream();
    expect(userTexts(core)).toContain("# context update");
    stream.finishResponse("end_turn");
    expect(await sent).toEqual({ type: "completed", stopReason: "end_turn" });
  });

  it("issues no request for an empty send when nothing is pending", async () => {
    const { core, mockClient } = createAgentWithMock({
      chatSupervisors: [{ hasPendingContent: () => Promise.resolve(false) }],
    });

    expect(await core.submit({ type: "resolved", messages: [] })).toEqual({
      type: "empty",
    });
    expect(mockClient.streams.length).toBe(0);
  });

  it("issues no request for a standing reminder alone, and still delivers it later", async () => {
    const { core, mockClient } = createAgentWithMock(
      {
        chatSupervisors: [{ hasPendingContent: () => Promise.resolve(false) }],
      },
      uniqueThreadId("empty-send-reminder"),
      (message) =>
        Promise.resolve({
          compact: false,
          messages: message
            ? [
                {
                  type: "text" as const,
                  nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
                  text: message,
                },
              ]
            : [],
          reminders: ["stay on task"],
        }),
    );

    expect(
      await core.submit({ type: "raw", message: pendingMessage("") }),
    ).toEqual({ type: "empty" });
    expect(mockClient.streams.length).toBe(0);

    const sent = core.submit({
      type: "resolved",
      messages: [
        {
          type: "text",
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
          text: "now do it",
        },
      ],
    });
    const stream = await mockClient.awaitStream();
    const request = stream.messages[stream.messages.length - 1];
    expect(JSON.stringify(request.content)).toContain("stay on task");
    stream.finishResponse("end_turn");
    await sent;
  });

  it("supersedes an empty send whose probe is still in flight", async () => {
    const { core, mockClient } = createAgentWithMock({
      chatSupervisors: [{ hasPendingContent: () => probe.promise }],
    });
    const probe = new Defer<boolean>();

    const first = core.submit({ type: "resolved", messages: [] });
    const second = core.submit({
      type: "resolved",
      messages: [
        {
          type: "text",
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
          text: "go",
        },
      ],
    });
    probe.resolve(true);
    expect(await first).toEqual({ type: "aborted" });
    const stream = await mockClient.awaitStream();
    expect(mockClient.streams.length).toBe(1);
    expect(core.isBusy).toBe(true);
    stream.finishResponse("end_turn");
    expect(await second).toEqual({ type: "completed", stopReason: "end_turn" });
    expect(core.isBusy).toBe(false);
  });
  it("does not consume pending content when the send is gated off", async () => {
    const supervisor = {
      hasPendingContent: () => Promise.resolve(available),
      onBeforeRequest: () =>
        Promise.resolve(
          available
            ? injectText("# context update")
            : { type: "none" as const },
        ),
    };
    const { core, mockClient } = createAgentWithMock({
      chatSupervisors: [supervisor],
    });
    let available = false;

    await core.submit({ type: "resolved", messages: [] });
    expect(mockClient.streams.length).toBe(0);

    available = true;
    const sent = core.submit({
      type: "resolved",
      messages: [
        {
          type: "text",
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
          text: "go",
        },
      ],
    });
    const stream = await mockClient.awaitStream();
    expect(userTexts(core)).toContain("# context update");
    stream.finishResponse("end_turn");
    await sent;
  });
});

describe("replaceable conversation core", () => {
  it("remains usable when reset is interrupted during disposal", async () => {
    const { core, mockClient } = createAgentWithMock();
    const original = core["core"];
    const reset = resetThread(core, { seed: [], archive: { type: "none" } });
    await core.abort();
    await reset;
    expect(core["core"]).not.toBe(original);
    expect(core["core"].isActive).toBe(true);
    const sent = core.submit({
      type: "resolved",
      messages: [
        {
          type: "text",
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
          text: "later request",
        },
      ],
    });
    const stream = await mockClient.awaitStream();
    stream.finishResponse("end_turn");
    expect(await sent).toEqual({ type: "completed", stopReason: "end_turn" });
    await core.destroy();
  });

  it("replaces conversation state but preserves the result contract and queues", async () => {
    const { core } = createAgentWithMock({
      chatSupervisors: [{ hasPendingContent: () => probe.promise }],
    });
    const original = core["core"];
    const result = core.result;
    const originalFileSupervisor = core.contextFiles;
    core["core"].edlRegisters.registers.set("old", "old content");
    core["core"].edlRegisters.nextSavedId = 4;
    original.preflightTokenCount = 42;
    const probe = new Defer<boolean>();

    const sent = core.submit({ type: "resolved", messages: [] });
    await core.submit(
      { type: "raw", message: pendingMessage("later") },
      "next",
    );
    await resetThread(core, {
      seed: [
        {
          type: "text",
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
          text: "summary",
        },
      ],
      archive: { type: "none" },
    });
    expect(core["core"]).not.toBe(original);
    expect(core.contextFiles).not.toBe(originalFileSupervisor);
    expect(core.contextFiles.files).toEqual(originalFileSupervisor.files);
    expect(core.result).toBe(result);
    expect(core["core"].edlRegisters.registers.size).toBe(0);
    expect(core["core"].edlRegisters.nextSavedId).toBe(0);
    expect(core.inputTokenCount).toBeUndefined();
    expect(core.completedTools.size).toBe(0);
    expect(core.queued.next).toEqual([
      { type: "raw", message: pendingMessage("later") },
    ]);
    expect(core.pendingTurnContent).toEqual([
      {
        type: "text",
        nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
        text: "summary",
      },
    ]);
    probe.resolve(true);
    expect(await sent).toEqual({ type: "aborted" });
    await core.destroy();
    expect(await result).toEqual({
      type: "aborted",
      reason: "thread destroyed before it yielded",
    });
  });

  it("an old probe cannot finish the replacement's first loop", async () => {
    const { core, mockClient } = createAgentWithMock({
      chatSupervisors: [{ hasPendingContent: () => probe.promise }],
    });
    const probe = new Defer<boolean>();

    const first = core.submit({ type: "resolved", messages: [] });
    await resetThread(core, { seed: [], archive: { type: "none" } });
    const second = core.submit({
      type: "resolved",
      messages: [
        {
          type: "text",
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
          text: "new generation",
        },
      ],
    });
    const stream = await mockClient.awaitStream();
    probe.resolve(true);
    expect(await first).toEqual({ type: "aborted" });
    expect(core.isBusy).toBe(true);
    expect(mockClient.streams).toHaveLength(1);
    stream.finishResponse("end_turn");
    expect(await second).toEqual({ type: "completed", stopReason: "end_turn" });
  });

  it.each([
    "abort",
    "reset",
    "destroy",
  ] as const)("%s invalidates a pending yield decision", async (action) => {
    const { core, mockClient } = createAgentWithMock({
      chatSupervisors: [
        {
          onYield: () => {
            entered.resolve();
            return decision.promise;
          },
        },
      ],
      threadType: "subagent" as ThreadType,
    });
    const entered = new Defer<void>();
    const decision = new Defer<{ type: "accept" }>();

    const sent = core.submit({
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
    stream.streamToolUse(
      "late-yield" as ToolRequestId,
      "yield_to_parent" as ToolName,
      { result: "done" },
    );
    stream.finishResponse("end_turn");
    await entered.promise;
    if (action === "reset")
      await resetThread(core, { seed: [], archive: { type: "none" } });
    else await core[action]();
    decision.resolve({ type: "accept" });
    expect(await sent).toEqual({ type: "aborted" });
    expect(core.yielded).toBeUndefined();
    expect(mockClient.streams).toHaveLength(1);
    await core.destroy();
  });

  it("keeps an already yielded result across replacement", async () => {
    const { core, mockClient } = createAgentWithMock({
      threadType: "subagent" as ThreadType,
    });
    const result = core.result;
    const sent = core.submit({
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
    stream.streamToolUse(
      "yield-result" as ToolRequestId,
      "yield_to_parent" as ToolName,
      { result: "finished" },
    );
    stream.finishResponse("end_turn");
    expect(await sent).toEqual({
      type: "yielded",
      value: { result: "finished" },
    });
    await resetThread(core, { seed: [], archive: { type: "none" } });
    expect(core.result).toBe(result);
    expect(await result).toEqual({
      type: "yielded",
      value: { result: "finished" },
    });
    expect(core.yielded?.value).toEqual({ result: "finished" });
    expect(
      core.completedTools.get("yield-result" as ToolRequestId),
    ).toMatchObject({
      request: { toolName: "yield_to_parent", input: { result: "finished" } },
      result: { result: { status: "ok" } },
      structuredResult: undefined,
    });
    await core.destroy();
    expect(await core.result).toEqual(await result);
  });

  it("shares the immutable completed-tool archive across forks and resets", async () => {
    const { core, mockClient } = createAgentWithMock({
      threadType: "subagent",
    });
    const sent = core.submit({
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
    const id = "fork-title" as ToolRequestId;
    stream.streamToolUse(id, "thread_title" as ToolName, { title: "Work" });
    stream.streamToolUse(
      "fork-yield" as ToolRequestId,
      "yield_to_parent" as ToolName,
      { result: "done" },
    );
    stream.finishResponse("end_turn");
    await sent;
    const original = core.completedTools.get(id);
    expect(original).toBeDefined();
    const fork = await Thread.clone({
      sourceThread: core,
      newId: uniqueThreadId("fork-result-archive"),
      nativeMessageIdx:
        core.getProviderMessages()[0].content[0].nativeMessageIdx,
      context: threadCloneContext(core["context"]),
      callbacks: core.callbacks,
    });
    expect(fork.completedTools).toBe(core.completedTools);
    expect(fork.completedTools.get(id)).toEqual(original);
    expect(fork.completedTools.get(id)).toBe(original);
    expect(fork.completedTools.size).toBe(2);
    await resetThread(core, { seed: [], archive: { type: "none" } });
    expect(core.completedTools.get(id)).toBe(original);
    expect(fork.completedTools).toBe(core.completedTools);
    await core.destroy();
    expect(fork.completedTools.get(id)).toEqual(original);
    await fork.destroy();
  });

  it("rejects sends, submissions and resets after destruction", async () => {
    const { core, mockClient } = createAgentWithMock();
    await core.destroy();
    await expect(
      core.submit({
        type: "resolved",
        messages: [
          {
            type: "text",
            nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
            text: "late",
          },
        ],
      }),
    ).rejects.toThrow("destroyed");
    await expect(
      core.submit({ type: "raw", message: pendingMessage("late") }, "next"),
    ).rejects.toThrow("destroyed");
    await expect(
      resetThread(core, { seed: [], archive: { type: "none" } }),
    ).rejects.toThrow("destroyed");
    expect(mockClient.streams).toHaveLength(0);
  });
});

describe("submission generations", () => {
  it("preempts a submission still resolving its own input", async () => {
    const entered = new Defer<void>();
    const gate = new Defer<void>();
    const { core, mockClient } = createAgentWithMock(
      undefined,
      uniqueThreadId("generation-preempt"),
      async (message) => {
        entered.resolve();
        await gate.promise;
        return {
          compact: false,
          messages: [
            {
              type: "text" as const,
              nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
              text: message,
            },
          ],
          reminders: [],
        };
      },
    );
    const first = core.submit({ type: "raw", message: pendingMessage("slow") });
    await entered.promise;
    const second = core.submit({
      type: "resolved",
      messages: [
        {
          type: "text",
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
          text: "replacement",
        },
      ],
    });
    const stream = await mockClient.awaitStream();
    gate.resolve();
    expect(await first).toEqual({ type: "aborted" });
    expect(mockClient.streams).toHaveLength(1);
    expect(userTexts(core)).not.toContain("slow");
    stream.streamText("done");
    stream.finishResponse("end_turn");
    expect(await second).toEqual({ type: "completed", stopReason: "end_turn" });
    expect(core.lastResult()).toEqual({
      type: "completed",
      stopReason: "end_turn",
    });
  });
  it("ignores a before-request hook that outlives its core", async () => {
    const entered = new Defer<void>();
    const gate = new Defer<void>();
    let laterConsulted = 0;
    const { core, mockClient } = createAgentWithMock({
      chatSupervisors: [
        {
          onBeforeRequest: async () => {
            if (entered.resolved) return { type: "none" as const };
            entered.resolve();
            await gate.promise;
            return injectText("stale injection");
          },
        },
        {
          onBeforeRequest: () => {
            laterConsulted += 1;
            return Promise.resolve({ type: "none" as const });
          },
        },
      ],
    });
    const first = core.submit({
      type: "resolved",
      messages: [
        {
          type: "text",
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
          text: "start",
        },
      ],
    });
    await entered.promise;
    const reset = resetThread(core, { seed: [], archive: { type: "none" } });
    gate.resolve();
    await reset;
    expect(await first).toEqual({ type: "aborted" });
    // The retired core's request never went out, so the supervisors behind the
    // gated one were never reached.
    expect(laterConsulted).toBe(0);
    expect(mockClient.streams).toHaveLength(0);
    const second = core.submit({
      type: "resolved",
      messages: [
        {
          type: "text",
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
          text: "after reset",
        },
      ],
    });
    const stream = await mockClient.awaitStream();
    expect(userTexts(core)).not.toContain("stale injection");
    stream.streamText("done");
    stream.finishResponse("end_turn");
    expect((await second).type).toBe("completed");
  });
  it("settles the lifecycle result when destroy lands mid-turn", async () => {
    const { core, mockClient } = createAgentWithMock();
    const sent = core.submit({
      type: "resolved",
      messages: [
        {
          type: "text",
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
          text: "start",
        },
      ],
    });
    await mockClient.awaitStream();
    await core.destroy();
    expect(await core.result).toEqual({
      type: "aborted",
      reason: "thread destroyed before it yielded",
    });
    expect((await sent).type).toBe("aborted");
    expect(core.isBusy).toBe(false);
  });
});
describe("stale outer submissions", () => {
  it.each([
    "send",
    "reset",
  ] as const)("%s prevents a stale pending-content probe from finishing the replacement", async (action) => {
    const entered = new Defer<void>();
    const pending = new Defer<boolean>();
    const { core, mockClient } = createAgentWithMock({
      chatSupervisors: [
        {
          hasPendingContent: () => {
            entered.resolve();
            return pending.promise;
          },
        },
      ],
    });

    const first = core.submit({ type: "resolved", messages: [] });
    await entered.promise;
    if (action === "reset")
      await resetThread(core, { seed: [], archive: { type: "none" } });
    const second = core.submit({
      type: "resolved",
      messages: [
        {
          type: "text",
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
          text: "replacement",
        },
      ],
    });
    const stream = await mockClient.awaitStream();
    pending.resolve(true);
    expect(await first).toEqual({ type: "aborted" });
    expect(core.isBusy).toBe(true);
    expect(core.lastResult()).toBeUndefined();
    expect(mockClient.streams).toHaveLength(1);
    stream.streamText("done");
    stream.finishResponse("end_turn");
    expect(await second).toEqual({ type: "completed", stopReason: "end_turn" });
  });

  it.each([
    "send",
    "reset",
  ] as const)("%s discards a queued resolution still pending between turns", async (action) => {
    const entered = new Defer<void>();
    const gate = new Defer<void>();
    const { core, mockClient } = createAgentWithMock(
      undefined,
      uniqueThreadId(`stale-queue-${action}`),
      async (message) => {
        entered.resolve();
        await gate.promise;
        return {
          compact: false,
          messages: [
            {
              type: "text" as const,
              nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
              text: message,
            },
          ],
          reminders: ["stale reminder"],
        };
      },
    );
    const first = core.submit({
      type: "resolved",
      messages: [
        {
          type: "text",
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
          text: "start",
        },
      ],
    });
    const stream = await mockClient.awaitStream();
    await core.submit(
      { type: "raw", message: pendingMessage("stale queued message") },
      "next",
    );
    stream.streamText("ok");
    stream.finishResponse("end_turn");
    await entered.promise;
    expect(loopLabel(core.loopState)).toBe("preparing");
    if (action === "reset")
      await resetThread(core, { seed: [], archive: { type: "none" } });
    const second = core.submit({
      type: "resolved",
      messages: [
        {
          type: "text",
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
          text: "replacement",
        },
      ],
    });
    const replacement = await awaitNextStream(mockClient, stream);
    gate.resolve();
    expect(await first).toEqual({ type: "aborted" });
    expect(core.isBusy).toBe(true);
    expect(core.lastResult()).toBeUndefined();
    expect(core.activeReminders.has("stale reminder")).toBe(false);
    expect(userTexts(core)).not.toContain("stale queued message");
    expect(mockClient.streams).toHaveLength(2);
    replacement.streamText("done");
    replacement.finishResponse("end_turn");
    expect(await second).toEqual({ type: "completed", stopReason: "end_turn" });
  });

  it.each([
    { action: "send", decision: { type: "accept" as const } },
    {
      action: "send",
      decision: { type: "reject" as const, message: "stale rejection" },
    },
    { action: "reset", decision: { type: "accept" as const } },
    {
      action: "reset",
      decision: { type: "reject" as const, message: "stale rejection" },
    },
  ])("$action invalidates a pending $decision.type yield decision while replacement runs", async ({
    action,
    decision,
  }) => {
    const entered = new Defer<void>();
    const gate = new Defer<typeof decision>();
    let yields = 0;
    const { core, mockClient } = createAgentWithMock({
      chatSupervisors: [
        {
          onYield: () => {
            if (yields++ > 0) return Promise.resolve({ type: "none" as const });
            entered.resolve();
            return gate.promise;
          },
        },
      ],
      threadType: "subagent",
    });

    const first = core.submit({
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
    stream.streamToolUse(
      "stale-yield" as ToolRequestId,
      "yield_to_parent" as ToolName,
      { result: "old result" },
    );
    stream.finishResponse("tool_use");
    await entered.promise;
    if (action === "reset")
      await resetThread(core, { seed: [], archive: { type: "none" } });
    const second = core.submit({
      type: "resolved",
      messages: [
        {
          type: "text",
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
          text: "replacement",
        },
      ],
    });
    const replacement = await awaitNextStream(mockClient, stream);
    gate.resolve(decision);
    expect(await first).toEqual({ type: "aborted" });
    expect(core.yielded).toBeUndefined();
    expect(core.isBusy).toBe(true);
    expect(core.lastResult()).toBeUndefined();
    expect(userTexts(core)).not.toContain("stale rejection");
    expect(mockClient.streams).toHaveLength(2);
    replacement.streamToolUse(
      "current-yield" as ToolRequestId,
      "yield_to_parent" as ToolName,
      { result: "new result" },
    );

    replacement.finishResponse("tool_use");
    const expected = {
      type: "yielded",
      value: { result: "new result" },
    };
    expect(await second).toEqual(expected);
    expect(await core.result).toEqual(expected);
  });
});

describe("detached delivery batches", () => {
  it("reset retains untouched detached entries without restoring stale resolved output", async () => {
    const entered = new Defer<void>();
    const gate = new Defer<void>();
    const calls: string[] = [];
    const { core, mockClient } = createAgentWithMock(
      undefined,
      uniqueThreadId("detached-reset"),
      async (message) => {
        calls.push(message);
        if (message === "consumed") {
          entered.resolve();
          await gate.promise;
        }
        return {
          compact: false,
          messages: [
            {
              type: "text" as const,
              text: message,
              nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
            },
          ],
          reminders: [],
        };
      },
    );
    const input = (text: string) => ({
      type: "resolved" as const,
      messages: [
        {
          type: "text" as const,
          text,
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
        },
      ],
    });
    const sent = core.submit(input("start"));
    const first = await mockClient.awaitStream();
    for (const text of ["consumed", "retained"])
      await core.submit({ type: "raw", message: pendingMessage(text) }, "next");
    first.finishResponse("end_turn");
    await entered.promise;
    await resetThread(core, { seed: [], archive: { type: "none" } });
    expect(core.queued.next).toEqual([
      { type: "raw", message: pendingMessage("retained") },
    ]);
    gate.resolve();
    expect(await sent).toEqual({ type: "aborted" });
    const replacementSend = core.submit(input("replacement"));
    const replacement = await awaitNextStream(mockClient, first);
    replacement.finishResponse("end_turn");
    const last = await awaitNextStream(mockClient, replacement);
    last.finishResponse("end_turn");
    await replacementSend;
    expect(calls).toEqual(["consumed", "retained"]);
    expect(userTexts(core)).not.toContain("consumed");
  });
  it.each([
    "async",
    "next",
  ] as const)("abort reports untouched %s leftovers before later arrivals", async (delivery) => {
    const entered = new Defer<void>();
    const gate = new Defer<void>();
    const calls: string[] = [];
    const { core, mockClient } = createAgentWithMock(
      undefined,
      uniqueThreadId("detached-abort"),
      async (message) => {
        calls.push(message);
        entered.resolve();
        await gate.promise;
        return { compact: false, messages: [], reminders: ["stale reminder"] };
      },
    );
    const sent = core.submit({
      type: "resolved",
      messages: [
        {
          type: "text",
          text: "start",
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
        },
      ],
    });
    const first = await mockClient.awaitStream();
    for (const text of ["consumed", "leftover"])
      await core.submit(
        { type: "raw", message: pendingMessage(text) },
        delivery,
      );
    first.finishResponse("end_turn");
    await entered.promise;
    await core.submit(
      { type: "raw", message: pendingMessage("arrival") },
      delivery,
    );
    const { unsent } = await core.abort();
    expect(unsent).toEqual(
      ["leftover", "arrival"].map((text) => ({
        when: delivery,
        message: { type: "raw", message: pendingMessage(text) },
      })),
    );
    gate.resolve();
    expect(await sent).toEqual({ type: "aborted" });
    expect(calls).toEqual(["consumed"]);
    expect(core.activeReminders.has("stale reminder")).toBe(false);
    expect(core.queued).toEqual({ async: [], next: [] });
  });

  it("a superseded flush cannot consume or restore the replacement's queue", async () => {
    const entered = new Defer<void>();
    const gate = new Defer<void>();
    const calls: string[] = [];
    const { core, mockClient } = createAgentWithMock(
      undefined,
      uniqueThreadId("detached-preempt"),
      async (message) => {
        calls.push(message);
        if (message === "old") {
          entered.resolve();
          await gate.promise;
        }
        return {
          compact: message === "old",
          messages: [
            {
              type: "text" as const,
              text: message,
              nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
            },
          ],
          reminders: [],
        };
      },
    );
    const input = (text: string) => ({
      type: "resolved" as const,
      messages: [
        {
          type: "text" as const,
          text,
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
        },
      ],
    });
    const firstSend = core.submit(input("start"));
    const first = await mockClient.awaitStream();
    for (const text of ["old", "obsolete leftover"])
      await core.submit({ type: "raw", message: pendingMessage(text) }, "next");
    first.finishResponse("end_turn");
    await entered.promise;
    const replacementSend = core.submit(input("replacement"));
    const replacement = await awaitNextStream(mockClient, first);
    await core.submit(
      { type: "raw", message: pendingMessage("new queue") },
      "next",
    );
    gate.resolve();
    expect(await firstSend).toEqual({ type: "aborted" });
    expect(core.queued.next).toEqual([
      { type: "raw", message: pendingMessage("new queue") },
    ]);
    replacement.finishResponse("end_turn");
    const last = await awaitNextStream(mockClient, replacement);
    last.finishResponse("end_turn");
    await replacementSend;
    expect(calls).toEqual(["old", "new queue"]);
  });

  it("enqueues during resolution stay outside the current batch", async () => {
    const entered = new Defer<void>();
    const gate = new Defer<void>();
    const { core, mockClient } = createAgentWithMock(
      undefined,
      uniqueThreadId("batch-boundary"),
      async (message) => {
        if (message === "first batch") {
          entered.resolve();
          await gate.promise;
        }
        return {
          compact: false,
          messages: [
            {
              type: "text" as const,
              text: message,
              nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
            },
          ],
          reminders: [],
        };
      },
    );
    const sent = core.submit({
      type: "resolved",
      messages: [
        {
          type: "text",
          text: "start",
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
        },
      ],
    });
    const first = await mockClient.awaitStream();
    await core.submit(
      { type: "raw", message: pendingMessage("first batch") },
      "next",
    );
    first.finishResponse("end_turn");
    await entered.promise;
    await core.submit(
      { type: "raw", message: pendingMessage("later batch") },
      "next",
    );
    gate.resolve();
    const second = await awaitNextStream(mockClient, first);
    expect(userTexts(core)).toContain("first batch");
    expect(userTexts(core)).not.toContain("later batch");
    second.finishResponse("end_turn");
    const third = await awaitNextStream(mockClient, second);
    expect(userTexts(core)).toContain("later batch");
    third.finishResponse("end_turn");
    await sent;
  });
});
