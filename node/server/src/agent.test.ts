// biome-ignore-all lint/complexity/useLiteralKeys: White-box lifecycle tests deliberately access private implementation state.
import * as fs from "node:fs/promises";
import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import type { ToolApplied } from "./capabilities/context-tracker.ts";
import type { OutputLine, Shell, ShellResult } from "./capabilities/shell.ts";
import type { ThreadId, ThreadType } from "./chat-types.ts";
import type { CompactionOutcome, Compactor } from "./compaction/index.ts";
import { TokenBudget } from "./compaction/token-budget.ts";
import { InMemoryFileIO } from "./edl/in-memory-file-io.ts";
import type { ProviderProfile } from "./provider-options.ts";
import { anthropicInferenceOptions } from "./providers/anthropic.ts";
import { AnthropicInferenceManager } from "./providers/anthropic-inference.ts";
import { ABORT_MARKER_TEXT } from "./providers/inference-shared.ts";
import { MockAnthropicClient } from "./providers/mock-anthropic-client.ts";
import type {
  AgentInput,
  CreateInferenceManagerOptions,
  InferenceOptions,
  NativeInferenceManager,
  NativeMessageIdx,
  Provider,
  ProviderMessage,
} from "./providers/provider-types.ts";
import {
  parseCompact,
  pendingMessage,
  type ResolveSubmission,
} from "./submission/index.ts";
import {
  awaitNextStream,
  cleanupArchive,
  cloneThread,
  compactorSlot,
  compactResolved,
  createAgentWithMock,
  createTestAgent,
  defaultAnthropicOptions,
  flatLoop,
  markTornDownYield,
  resetThread,
  sendResolved,
  TEST_ARCHIVE_DIR,
  uniqueThreadId,
  userInput,
} from "./test-helpers.ts";
import type { Thread, ThreadContext } from "./thread.ts";
import type { SubmissionResult } from "./thread-api.ts";
import { flushArchive } from "./thread-logger.ts";
import { activeTools, activityLabel } from "./thread-state.ts";
import {
  injectText,
  MaxTokensSupervisor,
  SubagentSupervisor,
  type SubmissionSupervisor,
  type ToolLoopSupervisor,
  UnsupervisedSupervisor,
} from "./thread-supervisor.ts";
import type {
  CompletedToolInfo,
  ToolName,
  ToolRequestId,
} from "./tool-types.ts";
import type { ClientToolContext } from "./tools/create-tool.ts";
import { Defer, delay, pollUntil } from "./utils/async.ts";
import type { AbsFilePath } from "./utils/files.ts";
import { threadConversationLogPath } from "./utils/files.ts";

function autoCompactSupervisors(
  opts: Parameters<typeof TokenBudget.create>[0],
  turnBefore: SubmissionSupervisor[] = [],
) {
  return {
    submissionSupervisors: turnBefore,
    compaction: {
      compactor: {
        run: () => Promise.reject(new Error("unexpected compaction")),
      },
      tokenBudget: TokenBudget.create(opts),
    },
  };
}

describe("Thread.state", () => {
  it("is idle with no result before anything is sent", () => {
    const { core } = createAgentWithMock();
    expect(core.state).toEqual({ type: "idle" });
    expect(core.lastResult()).toBeUndefined();
  });
  it("is running/streaming during a turn and idle/completed after it", async () => {
    const { core, mockClient } = createAgentWithMock();
    void core.submit({
      type: "resolved",
      messages: [
        {
          type: "text",
          text: "hello",
        },
      ],
    });
    const stream = await mockClient.awaitStream();
    await pollUntil(() => {
      if (core.state.type === "running") return true;
      throw new Error(`waiting for running, currently: ${core.state.type}`);
    });
    const running = core.state;
    if (running.type !== "running") throw new Error("expected running");
    expect(running.activity.type).toBe("streaming");
    stream.streamText("hi");
    stream.finishResponse("end_turn");
    await pollUntil(() => {
      if (core.state.type === "idle") return true;
      throw new Error(`waiting for idle, currently: ${core.state.type}`);
    });
    expect(core.state.type).toBe("idle");
    expect(core.lastResult()).toEqual({
      type: "completed",
      stopReason: "end_turn",
    });
  });
  it("reports a failed submission as idle with the resubmit text", async () => {
    const { core, mockClient } = createAgentWithMock();
    void core.submit({
      type: "resolved",
      messages: [
        {
          type: "text",
          text: "find the bug",
        },
      ],
    });
    const stream = await mockClient.awaitStream();
    stream.respondWithError(new Error("provider failure"));
    await pollUntil(() => {
      if (core.state.type === "idle") return true;
      throw new Error(`waiting for idle, currently: ${core.state.type}`);
    });
    expect(core.state.type).toBe("idle");
    const lastResult = core.lastResult();
    if (lastResult?.type !== "failed") throw new Error("expected failed");
    expect(lastResult.error.message).toBe("provider failure");
  });

  it("reports an aborted turn as idle with an aborted result", async () => {
    const { core, mockClient } = createAgentWithMock();
    void core.submit({
      type: "resolved",
      messages: [
        {
          type: "text",
          text: "hello",
        },
      ],
    });
    const stream = await mockClient.awaitStream();
    stream.streamText("partial");
    await core.abort();
    await pollUntil(() => {
      if (core.state.type === "idle") return true;
      throw new Error(`waiting for idle, currently: ${core.state.type}`);
    });
    expect(core.state).toEqual({
      type: "idle",
      lastResult: { type: "aborted" },
    });
  });

  it("surfaces a structured yield as a structured result", async () => {
    const { core, mockClient } = createAgentWithMock({
      threadType: "subagent" as ThreadType,
      yieldSchema: {
        type: "object",
        properties: { count: { type: "number" } },
        required: ["count"],
      },
    });
    void core.submit({
      type: "resolved",
      messages: [
        {
          type: "text",
          text: "do the task",
        },
      ],
    });
    const stream = await mockClient.awaitStream();
    stream.streamToolUse(
      "tool-phase-structured" as ToolRequestId,
      "yield_to_parent" as ToolName,
      { count: 3 },
    );
    stream.finishResponse("end_turn");
    await pollUntil(() => {
      if (core.yielded) return true;
      throw new Error("waiting for yield");
    });
    expect(core.yielded).toBeDefined();
    expect(core.lastResult()).toEqual({
      type: "yielded",
      value: { count: 3 },
    });
  });

  it("reports a yield as an idle thread with a yielded result", async () => {
    const { core, mockClient } = createAgentWithMock({
      threadType: "subagent" as ThreadType,
    });
    void core.submit({
      type: "resolved",
      messages: [
        {
          type: "text",
          text: "do the task",
        },
      ],
    });
    const stream = await mockClient.awaitStream();
    stream.streamToolUse(
      "tool-phase-yield" as ToolRequestId,
      "yield_to_parent" as ToolName,
      { result: "done" },
    );
    stream.finishResponse("end_turn");
    await pollUntil(() => {
      if (core.yielded) return true;
      throw new Error("waiting for yield");
    });
    expect(core.yielded).toBeDefined();
    expect(core.lastResult()).toEqual({
      type: "yielded",
      value: { result: "done" },
    });
  });
});
describe("Thread.submit result", () => {
  it("resolves completed when the agent reaches end_turn", async () => {
    const { core, mockClient } = createAgentWithMock();
    const result = core.submit({
      type: "resolved",
      messages: [
        {
          type: "text",
          text: "hello",
        },
      ],
    });
    const stream = await mockClient.awaitStream();
    stream.streamText("hi");
    stream.finishResponse("end_turn");
    expect(await result).toEqual({ type: "completed", stopReason: "end_turn" });
  });
  it("resolves yielded with the unchanged default input", async () => {
    const { core, mockClient } = createAgentWithMock({
      threadType: "subagent" as ThreadType,
    });
    const result = core.submit({
      type: "resolved",
      messages: [
        {
          type: "text",
          text: "do the task",
        },
      ],
    });
    const stream = await mockClient.awaitStream();
    stream.streamToolUse(
      "send-yield-text" as ToolRequestId,
      "yield_to_parent" as ToolName,
      { result: "done" },
    );
    stream.finishResponse("end_turn");
    expect(await result).toEqual({
      type: "yielded",
      value: { result: "done" },
    });
  });
  it.each([
    { result: 42, nested: { items: [1, null, "three"] } },
    { result: '{"count":3}', type: "text", text: "not a wrapper" },
  ])("passes custom input unchanged to hooks and consumers: %j", async (input) => {
    const { core, mockClient } = createAgentWithMock({
      submissionSupervisors: [
        {
          onYield: async (value) => {
            expect(value).toEqual(input);
            return { type: "accept", resultPrefix: "synced" };
          },
        },
      ],
      threadType: "subagent" as ThreadType,
      yieldSchema: {
        type: "object",
        properties: { result: {} },
        required: ["result"],
      },
    });

    const result = core.submit({
      type: "resolved",
      messages: [
        {
          type: "text",
          text: "do the task",
        },
      ],
    });
    const stream = await mockClient.awaitStream();
    stream.streamToolUse(
      "send-yield-structured" as ToolRequestId,
      "yield_to_parent" as ToolName,
      input,
    );
    stream.finishResponse("end_turn");
    expect(await result).toEqual({
      type: "yielded",
      value: input,
      resultPrefix: "synced",
    });
    expect(await core.result).toEqual(await result);
    expect(core.lastResult()).toEqual(await result);
    expect(
      core.completedTools.get("send-yield-structured" as ToolRequestId),
    ).toMatchObject({
      request: { input },
      result: { result: { status: "ok" } },
      structuredResult: undefined,
    });
  });
  it("resolves aborted when the turn is aborted", async () => {
    const { core, mockClient } = createAgentWithMock();
    const result = core.submit({
      type: "resolved",
      messages: [
        {
          type: "text",
          text: "hello",
        },
      ],
    });
    const stream = await mockClient.awaitStream();
    stream.streamText("partial");
    await core.abort();
    expect(await result).toEqual({ type: "aborted" });
  });
  it("resolves failed on a non-retryable error", async () => {
    const { core, mockClient } = createAgentWithMock();
    const result = core.submit({
      type: "resolved",
      messages: [
        {
          type: "text",
          text: "find the bug",
        },
      ],
    });
    const stream = await mockClient.awaitStream();
    stream.respondWithError(new Error("provider failure"));
    const settled = await result;
    if (settled.type !== "failed") throw new Error("expected failed");
    expect(settled.error.message).toBe("provider failure");
  });
  it("resolves empty rather than hanging when there is nothing to send", async () => {
    const { core } = createAgentWithMock();
    expect(await core.submit({ type: "resolved", messages: [] })).toEqual({
      type: "empty",
    });
  });
  it("resolves empty rather than hanging on an empty raw send", async () => {
    const { core } = createAgentWithMock({
      threadType: "compact" as ThreadType,
    });
    expect(await core.submit({ type: "resolved", messages: [] })).toEqual({
      type: "empty",
    });
  });
  it("rejects once the thread's container has been torn down", async () => {
    const { core } = createAgentWithMock({
      threadType: "subagent" as ThreadType,
    });
    markTornDownYield(core, { result: "done" });
    await expect(
      core.submit({
        type: "resolved",
        messages: [
          {
            type: "text",
            text: "more",
          },
        ],
      }),
    ).rejects.toThrow(/torn down/);
  });
  it("reports a queued send as queued rather than borrowing another submission's outcome", async () => {
    const { core, mockClient } = createAgentWithMock();
    const first = core.submit({
      type: "resolved",
      messages: [
        {
          type: "text",
          text: "hello",
        },
      ],
    });
    const stream = await mockClient.awaitStream();
    core.enqueue(
      {
        type: "resolved",
        messages: [
          {
            type: "text",
            text: "and also",
          },
        ],
      },
      "async",
    );
    expect(core.queued.async).toHaveLength(1);
    stream.streamText("hi");
    stream.finishResponse("end_turn");
    const second = await awaitNextStream(mockClient, stream);
    second.streamText("and also hi");
    second.finishResponse("end_turn");
    expect(await first).toEqual({ type: "completed", stopReason: "end_turn" });
  });
});
describe("Thread turn loop", () => {
  it("stays busy while a continuation is being prepared, so a send cannot race it", async () => {
    let releaseResolve: (() => void) | undefined;
    let resolveEntered: (() => void) | undefined;
    const entered = new Promise<void>((r) => {
      resolveEntered = r;
    });
    const gate = new Promise<void>((r) => {
      releaseResolve = r;
    });
    const { core, mockClient } = createAgentWithMock(
      undefined,
      uniqueThreadId("loop-race"),
      async (message) => {
        resolveEntered?.();
        await gate;
        return sendResolved([
          {
            type: "text" as const,
            text: message,
          },
        ]);
      },
    );
    const sent = core.submit({
      type: "resolved",
      messages: [
        {
          type: "text",
          text: "start",
        },
      ],
    });
    const stream = await mockClient.awaitStream();
    core.enqueue(
      { type: "raw", message: pendingMessage("queued follow-up") },
      "next",
    );
    stream.streamText("ok");
    stream.finishResponse("end_turn");
    // The agent has settled and is idle; the loop is inside the flush that
    // will build the continuation. A send arriving now must not start a
    // concurrent turn.
    await entered;
    const streamsBefore = mockClient.streams.length;
    expect(core.isBusy).toBe(true);
    core.enqueue({ type: "raw", message: pendingMessage("racer") }, "async");
    expect(mockClient.streams.length).toBe(streamsBefore);
    releaseResolve?.();
    // The racer landed on the async queue, so it rides the continuation the
    // flush was building rather than needing a request of its own.
    const second = await awaitNextStream(mockClient, stream);
    second.streamText("done");
    second.finishResponse("end_turn");
    expect(await sent).toEqual({ type: "completed", stopReason: "end_turn" });
  });
  it("keeps the submitted message in the log when a continuation fails", async () => {
    const { core, mockClient } = createAgentWithMock(
      { submissionSupervisors: [MaxTokensSupervisor.create()] },
      uniqueThreadId("continuation-failure"),
    );

    const sent = core.submit({
      type: "resolved",
      messages: [
        {
          type: "text",
          text: "original message",
        },
      ],
    });
    const stream = await mockClient.awaitStream();
    stream.streamText("truncated");
    stream.finishResponse("max_tokens");
    const continuation = await awaitNextStream(mockClient, stream);
    continuation.respondWithError(new Error("continuation failure"));
    const result = await sent;
    if (result.type !== "failed") throw new Error("expected failed");
    // Nothing is discarded on failure, so the submitted message is still in
    // the log and a retry re-issues the continuation.
    expect(
      core
        .getProviderMessages()
        .some(
          (m) =>
            m.role === "user" &&
            JSON.stringify(m.content).includes("original message"),
        ),
    ).toBe(true);
  });
});
/** Record handoffs through the same compactor capability as production. */
function trackCompactions(core: Thread): { prompts: (string | undefined)[] } {
  const prompts: (string | undefined)[] = [];
  compactorSlot(core).compactor = {
    run: async (_messages, prompt) => {
      prompts.push(nextText(prompt));
      return { type: "aborted" };
    },
  };
  return { prompts };
}

describe("Thread submissions across a compaction handoff", () => {
  /** A compactor that summarizes without talking to a provider. */
  const stubCompactor = (
    outcome: CompactionOutcome = {
      type: "complete",
      summary: { text: "SUMMARY TEXT", chunkCount: 1 },
      next: [],
    },
  ): Compactor & { calls: (string | undefined)[] } => {
    const calls: (string | undefined)[] = [];
    return {
      calls,
      run: (_messages, next) => {
        calls.push(nextText(next));
        return Promise.resolve(
          outcome.type === "complete" || outcome.type === "carried"
            ? { ...outcome, next: [...next] }
            : outcome,
        );
      },
    };
  };

  const resolveCompact: ResolveSubmission = async (message) => {
    const { compact, rest } = parseCompact(message);
    return compact
      ? compactResolved(rest ? [{ type: "text", text: rest }] : [])
      : sendResolved(rest ? [{ type: "text", text: rest }] : []);
  };
  /** Compacts at the next stop, via a queued `@compact`. */
  const queueCompact = (core: Thread, prompt = "") =>
    core.enqueue(
      { type: "raw", message: pendingMessage(`@compact ${prompt}`.trim()) },
      "next",
    );

  it("stays pending until the post-compaction turn comes to rest", async () => {
    const threadId = uniqueThreadId("send-compaction");
    const { core, mockClient } = createAgentWithMock(
      { resolve: resolveCompact },
      threadId,
    );
    try {
      const compactor = stubCompactor();
      const oldAgent = core["core"].manager;
      let settled: SubmissionResult | undefined;
      compactorSlot(core).compactor = compactor;
      const result = core.submit({
        type: "resolved",
        messages: [
          {
            type: "text",
            text: "hello",
          },
        ],
      });
      void result.then((r) => {
        settled = r;
      });
      const stream = await mockClient.awaitStream();
      queueCompact(core, "carry on");
      stream.streamText("done");
      stream.finishResponse("end_turn");
      const contStream = await pollUntil(() => {
        if (core["core"].manager === oldAgent)
          throw new Error("waiting for swap");
        return awaitNextStream(mockClient, stream);
      });
      expect(settled).toBeUndefined();
      expect(compactor.calls).toEqual(["carry on"]);
      expect(JSON.stringify(contStream.messages)).toContain("SUMMARY TEXT");
      contStream.streamText("resumed");
      contStream.finishResponse("end_turn");
      expect(await result).toEqual({
        type: "completed",
        stopReason: "end_turn",
      });
    } finally {
      await core.destroy();
      await flushArchive(core);
      await cleanupArchive(threadId);
    }
  });

  it("carries without a summary opening or compaction archive when nothing was summarized", async () => {
    const threadId = uniqueThreadId("send-compaction-carried");
    const { core, mockClient } = createAgentWithMock(
      { resolve: resolveCompact },
      threadId,
    );
    try {
      const oldAgent = core["core"].manager;
      compactorSlot(core).compactor = stubCompactor({
        type: "carried",
        next: [],
      });
      const result = core.submit({
        type: "resolved",
        messages: [{ type: "text", text: "hello" }],
      });
      const stream = await mockClient.awaitStream();
      queueCompact(core, "carried prompt");
      stream.streamText("done");
      stream.finishResponse("end_turn");
      const contStream = await pollUntil(() => {
        if (core["core"].manager === oldAgent)
          throw new Error("waiting for swap");
        return awaitNextStream(mockClient, stream);
      });
      const sent = JSON.stringify(contStream.messages);
      expect(sent).not.toContain("SUMMARY TEXT");
      expect(contStream.messages).toHaveLength(1);
      expect(contStream.messages[0].content.at(-1)).toMatchObject({
        type: "text",
        text: "carried prompt",
      });
      contStream.streamText("resumed");
      contStream.finishResponse("end_turn");
      await result;
      await flushArchive(core);
      const types = (await readArchive(threadId)).map((e) => e.type);
      expect(types).not.toContain("compaction");
    } finally {
      await core.destroy();
      await flushArchive(core);
      await cleanupArchive(threadId);
    }
  });

  it("falls back to the default continuation when the prompt resolves to nothing", async () => {
    const threadId = uniqueThreadId("send-compaction-empty-prompt");
    const { core, mockClient } = createAgentWithMock(
      { resolve: resolveCompact },
      threadId,
    );
    try {
      // The owner resolves the `@compact` prompt at handoff time; a prompt made
      // entirely of commands can expand to nothing, and an empty user turn is
      // not something to send.

      const oldAgent = core["core"].manager;
      compactorSlot(core).compactor = stubCompactor();
      const result = core.submit({
        type: "resolved",
        messages: [
          {
            type: "text",
            text: "hello",
          },
        ],
      });
      const stream = await mockClient.awaitStream();
      queueCompact(core);
      stream.streamText("done");
      stream.finishResponse("end_turn");
      const contStream = await pollUntil(() => {
        if (core["core"].manager === oldAgent)
          throw new Error("waiting for swap");
        return awaitNextStream(mockClient, stream);
      });
      expect(JSON.stringify(contStream.messages)).toContain(
        "Please continue from where you left off.",
      );
      contStream.streamText("resumed");
      contStream.finishResponse("end_turn");
      expect(await result).toEqual({
        type: "completed",
        stopReason: "end_turn",
      });
    } finally {
      await core.destroy();
      await flushArchive(core);
      await cleanupArchive(threadId);
    }
  });

  it("sends an @compact prompt's image verbatim after compaction", async () => {
    const threadId = uniqueThreadId("send-compaction-image");
    const image: AgentInput = {
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "SU1BR0U=" },
    };
    const { core, mockClient } = createAgentWithMock(
      {
        resolve: async () =>
          compactResolved([{ type: "text", text: "look" }, image]),
      },
      threadId,
    );
    try {
      const compactor = stubCompactor();
      compactorSlot(core).compactor = compactor;
      const result = core.submit({
        type: "raw",
        message: pendingMessage("@compact look"),
      });
      const stream = await mockClient.awaitStream();
      const lastUser = stream.messages.at(-1);
      expect(JSON.stringify(lastUser)).toContain("SU1BR0U=");
      expect(JSON.stringify(lastUser)).toContain('"type":"image"');
      expect(compactor.calls).toEqual(["look"]);
      stream.finishResponse("end_turn");
      await result;
    } finally {
      await core.destroy();
      await flushArchive(core);
      await cleanupArchive(threadId);
    }
  });
  it("stays pending across two consecutive handoffs, reseeding each time", async () => {
    const threadId = uniqueThreadId("send-compaction-twice");
    const prompts = ["first continuation", "second continuation"];
    const { core, mockClient } = createAgentWithMock(
      { resolve: resolveCompact },
      threadId,
    );
    try {
      const calls: (string | undefined)[] = [];
      const compactor: Compactor = {
        run: (_messages, next) => {
          calls.push(nextText(next));
          return Promise.resolve({
            type: "complete",
            summary: { text: `SUMMARY ${calls.length}`, chunkCount: 1 },
            next: [...next],
          });
        },
      };
      let settled: SubmissionResult | undefined;
      compactorSlot(core).compactor = compactor;
      const result = core.submit({
        type: "resolved",
        messages: [
          {
            type: "text",
            text: "hello",
          },
        ],
      });
      void result.then((r) => {
        settled = r;
      });

      let stream = await mockClient.awaitStream();
      for (const [idx, prompt] of prompts.entries()) {
        const oldAgent = core["core"].manager;
        queueCompact(core, prompt);
        stream.streamText("done");
        stream.finishResponse("end_turn");
        const prev = stream;
        stream = await pollUntil(() => {
          if (core["core"].manager === oldAgent)
            throw new Error("waiting for swap");
          return awaitNextStream(mockClient, prev);
        });
        expect(settled).toBeUndefined();
        const body = JSON.stringify(stream.messages);
        // Each pass reseeds with the newest summary and its own next prompt,
        // and none of the earlier generations' content survives.
        expect(body).toContain(`SUMMARY ${idx + 1}`);
        expect(body).toContain(prompt);
        if (idx > 0) expect(body).not.toContain(`SUMMARY ${idx}"`);
      }
      expect(calls).toEqual(prompts);
      stream.streamText("resumed");
      stream.finishResponse("end_turn");
      expect(await result).toEqual({
        type: "completed",
        stopReason: "end_turn",
      });
    } finally {
      await core.destroy();
      await flushArchive(core);
      await cleanupArchive(threadId);
    }
  });

  const userText = (text: string): AgentInput[] => [{ type: "text", text }];
  const firstTurn = async (core: Thread, mockClient: MockAnthropicClient) => {
    const sent = core.submit({ type: "resolved", messages: userText("hello") });
    const stream = await mockClient.awaitStream();
    stream.streamText("done");
    stream.finishResponse("end_turn");
    await sent;
  };
  it.each([
    {
      trigger: "an explicit @compact while idle",
      expectedNext: ["carry on"],
      start: async (core: Thread, mockClient: MockAnthropicClient) => {
        await firstTurn(core, mockClient);
        return {
          result: core.submit({
            type: "raw",
            message: pendingMessage("@compact carry on"),
          }),
        };
      },
    },
    {
      trigger: "a queued @compact behind @next content",
      expectedNext: ["follow up", "carry on"],
      start: async (core: Thread, mockClient: MockAnthropicClient) => {
        const sent = core.submit({
          type: "resolved",
          messages: userText("hello"),
        });
        const stream = await mockClient.awaitStream();
        core.enqueue(
          { type: "raw", message: pendingMessage("follow up") },
          "next",
        );
        core.enqueue(
          { type: "raw", message: pendingMessage("@compact carry on") },
          "next",
        );
        stream.streamText("done");
        stream.finishResponse("end_turn");
        return { result: sent };
      },
    },
    {
      trigger: "a budget stop mid-submission",
      expectedNext: ["carry on"],
      start: async (core: Thread, mockClient: MockAnthropicClient) => {
        mockClient.mockInputTokenCount = 50;
        await firstTurn(core, mockClient);
        mockClient.mockInputTokenCountOnce = 200;
        return {
          result: core.submit({
            type: "resolved",
            messages: userText("again"),
          }),
        };
      },
    },
    {
      trigger: "a budget stop after a tool batch",
      expectedNext: ["carry on"],
      start: async (core: Thread, mockClient: MockAnthropicClient) => {
        mockClient.mockInputTokenCount = 50;
        const result = core.submit({
          type: "resolved",
          messages: userText("edit a"),
        });
        const stream = await mockClient.awaitStream();
        mockClient.mockInputTokenCountOnce = 200;
        stream.streamToolUse("edl-1" as ToolRequestId, "edl" as ToolName, {
          script: `file \`/tmp/missing.txt\`\nnarrow /x/\nreplace "y"`,
        });
        stream.finishResponse("tool_use");
        return { result };
      },
    },
  ])("ends $trigger in the same compacted state", async ({
    start,
    expectedNext,
  }) => {
    const threadId = uniqueThreadId("compaction-parity");
    const { core, mockClient } = createAgentWithMock(
      {
        resolve: resolveCompact,
        ...autoCompactSupervisors({ threshold: 100, handoff: "carry on" }),
      },
      threadId,
    );
    try {
      const compactor = stubCompactor();
      compactorSlot(core).compactor = compactor;
      const firstManager = core["core"].manager;
      const { result } = await start(core, mockClient);
      const contStream = await pollUntil(() => {
        if (core["core"].manager === firstManager)
          throw new Error("waiting for swap");
        const last = mockClient.streams.at(-1);
        if (!last || mockClient.streams.length < 2)
          throw new Error("waiting for the continuation");
        return last;
      });
      expect(compactor.calls).toHaveLength(1);
      const body = JSON.stringify(contStream.messages);
      expect(body).toContain("SUMMARY TEXT");
      for (const text of expectedNext) expect(body).toContain(text);
      expect(body).not.toContain("done");
      contStream.streamText("resumed");
      contStream.finishResponse("end_turn");
      expect(await result).toEqual({
        type: "completed",
        stopReason: "end_turn",
      });
    } finally {
      await core.destroy();
      await flushArchive(core);
      await cleanupArchive(threadId);
    }
  });

  it.each([
    {
      pending: true,
      expected: "Please continue from where you left off.",
      absent: undefined,
    },
    {
      pending: false,
      expected: "Please continue from where you left off.",
      absent: undefined,
    },
  ])("sends $expected after a budget stop with a blank handoff", async ({
    pending,
    expected,
    absent,
  }) => {
    const threadId = uniqueThreadId("blank-handoff");
    const { core, mockClient } = createAgentWithMock(
      {
        resolve: resolveCompact,
        ...autoCompactSupervisors({ threshold: 100, handoff: "  \n " }),
      },
      threadId,
    );
    try {
      const compactor = stubCompactor();
      compactorSlot(core).compactor = compactor;
      const firstManager = core["core"].manager;
      mockClient.mockInputTokenCount = 50;
      let result: Promise<unknown>;
      if (pending) {
        await firstTurn(core, mockClient);
        mockClient.mockInputTokenCountOnce = 200;
        result = core.submit({ type: "resolved", messages: userText("again") });
      } else {
        result = core.submit({
          type: "resolved",
          messages: userText("edit a"),
        });
        const stream = await mockClient.awaitStream();
        mockClient.mockInputTokenCountOnce = 200;
        stream.streamToolUse("edl-1" as ToolRequestId, "edl" as ToolName, {
          script: `file \`/tmp/missing.txt\`\nnarrow /x/\nreplace "y"`,
        });
        stream.finishResponse("tool_use");
      }
      const contStream = await pollUntil(() => {
        if (core["core"].manager === firstManager)
          throw new Error("waiting for swap");
        const last = mockClient.streams.at(-1);
        if (!last || mockClient.streams.length < 2)
          throw new Error("waiting for the continuation");
        return last;
      });
      expect(compactor.calls).toHaveLength(1);
      const body = JSON.stringify(contStream.messages);
      expect(body).toContain(expected);
      if (absent) expect(body).not.toContain(absent);
      contStream.streamText("resumed");
      contStream.finishResponse("end_turn");
      await result;
    } finally {
      await core.destroy();
      await flushArchive(core);
      await cleanupArchive(threadId);
    }
  });
  it("rests an explicit @compact on a thread without a compactor", async () => {
    const { core, mockClient } = createAgentWithMock({
      resolve: resolveCompact,
    });
    try {
      expect(core["context"].compaction).toBeUndefined();
      const result = await core.submit({
        type: "raw",
        message: pendingMessage("@compact carry on"),
      });
      expect(result).toEqual({ type: "completed", stopReason: "end_turn" });
      expect(mockClient.streams.length).toBe(0);
    } finally {
      await core.destroy();
    }
  });

  it("resolves failed when the summarizing pass errors out", async () => {
    const threadId = uniqueThreadId("compaction-error");
    const { core, mockClient } = createAgentWithMock(
      { resolve: resolveCompact },
      threadId,
    );
    try {
      compactorSlot(core).compactor = stubCompactor({
        type: "error",
        message: "boom",
      });
      const result = core.submit({
        type: "resolved",
        messages: [
          {
            type: "text",
            text: "hello",
          },
        ],
      });
      const stream = await mockClient.awaitStream();
      queueCompact(core);
      stream.streamText("done");
      stream.finishResponse("end_turn");
      expect(await result).toMatchObject({ type: "failed" });
    } finally {
      await core.destroy();
      await flushArchive(core);
      await cleanupArchive(threadId);
    }
  });
});

describe("Thread.reset", () => {
  it("starts an empty agent and keeps the thread's durables", async () => {
    const threadId = uniqueThreadId("thread-reset");
    const { core, mockClient } = createAgentWithMock(undefined, threadId);
    try {
      const sent = core.submit({
        type: "resolved",
        messages: [
          {
            type: "text",
            text: "the old conversation",
          },
        ],
      });
      const stream = await mockClient.awaitStream();
      stream.streamText("old reply");
      stream.finishResponse("end_turn");
      await sent;

      (core.completedTools as Map<ToolRequestId, CompletedToolInfo>).set(
        "tr-1" as ToolRequestId,
        {
          request: {
            id: "tr-1" as ToolRequestId,
            toolName: "thread_title" as ToolName,
            input: { title: "Old conversation" },
          },
          result: {
            type: "tool_result",
            id: "tr-1" as ToolRequestId,
            result: { status: "ok", value: [] },
          },
          structuredResult: { toolName: "thread_title" },
        },
      );
      const oldAgent = core["core"].manager;

      await resetThread(core, { archive: { type: "none" } });

      expect(core["core"].manager).not.toBe(oldAgent);
      expect(core.getProviderMessages()).toEqual([]);
      expect(core.completedTools.has("tr-1" as ToolRequestId)).toBe(true);
      // The registers belong to the message list being replaced: a saved
      // fragment refers to text the fresh agent has never seen.
      expect(core["core"].edlRegisters.registers.size).toBe(0);

      void core.submit({
        type: "resolved",
        messages: [
          {
            type: "text",
            text: "continue",
          },
        ],
      });
      const next = await awaitNextStream(mockClient, stream);
      const body = JSON.stringify(next.messages);
      expect(body).toContain("continue");
      expect(body).not.toContain("the old conversation");
      next.streamText("ok");
      next.finishResponse("end_turn");
    } finally {
      await core.destroy();
      await flushArchive(core);
      await cleanupArchive(threadId);
    }
  });

  it("with no seed and no archive record, starts an empty agent silently", async () => {
    const threadId = uniqueThreadId("thread-reset-bare");
    const { core, mockClient } = createAgentWithMock(undefined, threadId);
    try {
      const sent = core.submit({
        type: "resolved",
        messages: [
          {
            type: "text",
            text: "the old conversation",
          },
        ],
      });
      const stream = await mockClient.awaitStream();
      stream.streamText("old reply");
      stream.finishResponse("end_turn");
      await sent;
      await flushArchive(core);

      await resetThread(core, { archive: { type: "none" } });

      expect(core.getProviderMessages()).toEqual([]);
      const entries = await readArchive(threadId);
      expect(entries.map((e) => e.type)).not.toContain("compaction");

      void core.submit({
        type: "resolved",
        messages: [
          {
            type: "text",
            text: "continue",
          },
        ],
      });
      const next = await awaitNextStream(mockClient, stream);
      expect(JSON.stringify(next.messages)).not.toContain(
        "the old conversation",
      );
      next.streamText("ok");
      next.finishResponse("end_turn");
    } finally {
      await core.destroy();
      await flushArchive(core);
      await cleanupArchive(threadId);
    }
  });
});

describe("Agent.handleProviderStopped", () => {
  it("max_tokens with completed tool_use block routes through handleProviderStoppedWithToolUse", async () => {
    const { core, mockClient } = createAgentWithMock({
      threadType: "subagent" as ThreadType,
    });

    void core.submit({
      type: "resolved",
      messages: [
        {
          type: "text",
          text: "do the task",
        },
      ],
    });
    const stream = await mockClient.awaitStream();

    const toolUseId = "tool-yield-1" as ToolRequestId;

    // Stream a yield_to_parent tool_use, then stop with max_tokens
    stream.streamToolUse(toolUseId, "yield_to_parent" as ToolName, {
      result: "Here is the result of my work",
    });
    stream.finishResponse("max_tokens");

    // Agent should route to handleProviderStoppedWithToolUse,
    // which executes the yield tool, and maybeAutoRespond transitions to yielded mode
    await pollUntil(() => {
      if (core.yielded) return true;
      throw new Error(
        `waiting for yielded mode, currently: ${activityLabel(core.state)}`,
      );
    });

    const yielded = core.yielded;
    if (!yielded) throw new Error("expected a yield");
    expect(yielded.value).toEqual({ result: "Here is the result of my work" });
  });

  it("custom yieldSchema yields a structured JSON value", async () => {
    const { core, mockClient } = createAgentWithMock({
      threadType: "subagent" as ThreadType,
      yieldSchema: {
        type: "object",
        properties: { count: { type: "number" } },
        required: ["count"],
      },
    });

    void core.submit({
      type: "resolved",
      messages: [
        {
          type: "text",
          text: "do the task",
        },
      ],
    });
    const stream = await mockClient.awaitStream();

    const toolUseId = "tool-yield-structured" as ToolRequestId;
    stream.streamToolUse(toolUseId, "yield_to_parent" as ToolName, {
      count: 3,
    });
    stream.finishResponse("max_tokens");

    await pollUntil(() => {
      if (core.yielded) return true;
      throw new Error(
        `waiting for yielded mode, currently: ${activityLabel(core.state)}`,
      );
    });

    const yielded = core.yielded;
    if (!yielded) throw new Error("expected a yield");
    expect(yielded.value).toEqual({ count: 3 });
  });
  it("max_tokens with truncated (incomplete) tool_use block sends error tool_result and auto-continues", async () => {
    const { core, mockClient } = createAgentWithMock();

    void core.submit({
      type: "resolved",
      messages: [
        {
          type: "text",
          text: "hello",
        },
      ],
    });
    const stream = await mockClient.awaitStream();

    const toolUseId = "tool-1" as ToolRequestId;

    // Stream a tool_use block with incomplete JSON input.
    // The real API always sends content_block_stop even at max_tokens.
    // partialParse will produce {} for the truncated JSON, which fails validation.
    const blockIndex = stream.nextBlockIndex();
    stream.emitEvent({
      type: "content_block_start",
      index: blockIndex,
      content_block: {
        type: "tool_use",
        id: toolUseId,
        name: "get_files" as ToolName,
        input: {},
        caller: { type: "direct" as const },
      },
    });
    stream.emitEvent({
      type: "content_block_delta",
      index: blockIndex,
      delta: { type: "input_json_delta", partial_json: '{"filePath":' },
    });
    stream.emitEvent({ type: "content_block_stop", index: blockIndex });
    stream.finishResponse("max_tokens");

    // The truncated tool_use should be visible and get an error tool_result,
    // then the agent should auto-continue
    // Wait for at least one more stream to appear
    await pollUntil(() => {
      if (mockClient.streams.length > 1) return true;
      throw new Error("waiting for next stream");
    });

    // The second stream should contain the tool_result in its messages.
    // It may not be in the very last user message (system reminders follow),
    // so search backwards for a user message containing tool_result.
    const secondStream = mockClient.streams[1];
    let toolResult: Anthropic.Messages.ToolResultBlockParam | undefined;
    for (let i = secondStream.messages.length - 1; i >= 0; i--) {
      const msg = secondStream.messages[i];
      if (msg.role !== "user" || typeof msg.content === "string") continue;
      toolResult = (
        msg.content as Anthropic.Messages.ToolResultBlockParam[]
      ).find(
        (b): b is Anthropic.Messages.ToolResultBlockParam =>
          b.type === "tool_result" && b.tool_use_id === toolUseId,
      );
      if (toolResult) break;
    }
    expect(
      toolResult,
      `Expected tool_result in stream messages: ${JSON.stringify(
        secondStream.messages.map((m) => ({
          role: m.role,
          content: m.content,
        })),
        null,
        2,
      )}`,
    ).toBeDefined();
    expect(toolResult!.is_error).toBe(true);
  });
});

describe("MaxTokensSupervisor", () => {
  /** Every text block of the last user message on a stream. */
  const lastUserText = (stream: { messages: Anthropic.MessageParam[] }) => {
    const last = stream.messages[stream.messages.length - 1];
    expect(last.role).toBe("user");
    return (last.content as Anthropic.Messages.ContentBlockParam[])
      .filter((b): b is Anthropic.Messages.TextBlockParam => b.type === "text")
      .map((b) => b.text)
      .join("\n");
  };

  it("continues a truncated text-only response", async () => {
    const { core, mockClient } = createAgentWithMock({
      submissionSupervisors: [MaxTokensSupervisor.create()],
    });

    void core.submit({
      type: "resolved",
      messages: [
        {
          type: "text",
          text: "hello",
        },
      ],
    });
    const stream = await mockClient.awaitStream();
    stream.streamText("Here is a long response that got");
    stream.finishResponse("max_tokens");

    const nextStream = await awaitNextStream(mockClient, stream);
    expect(lastUserText(nextStream)).toContain("truncated");
  });

  it("is the only supervisor to speak on max_tokens, and spends no restart", async () => {
    const unsupervised = UnsupervisedSupervisor.create();
    const { core, mockClient } = createAgentWithMock({
      submissionSupervisors: [MaxTokensSupervisor.create(), unsupervised],
    });

    void core.submit({
      type: "resolved",
      messages: [
        {
          type: "text",
          text: "hello",
        },
      ],
    });
    const stream = await mockClient.awaitStream();
    stream.streamText("cut off");
    stream.finishResponse("max_tokens");

    const continuation = await awaitNextStream(mockClient, stream);
    const continuationText = lastUserText(continuation);
    expect(continuationText).toContain("truncated");
    expect(continuationText).not.toContain("stopped without yielding");

    // The truncated stop was not a refusal to yield, so the restart budget is
    // untouched: the first end_turn still gets restart 1.
    continuation.streamText("done");
    continuation.finishResponse("end_turn");
    const restart = await awaitNextStream(mockClient, continuation);
    expect(lastUserText(restart)).toContain("auto-restart 1/5");
  });
  it("takes precedence over a subagent's yield-tag nudge", async () => {
    const { core, mockClient } = createAgentWithMock({
      submissionSupervisors: [
        MaxTokensSupervisor.create(),
        SubagentSupervisor.create(),
      ],
      threadType: "subagent" as ThreadType,
    });

    void core.submit({
      type: "resolved",
      messages: [
        {
          type: "text",
          text: "do the task",
        },
      ],
    });
    const stream = await mockClient.awaitStream();
    stream.streamText("<yield>partial resu");
    stream.finishResponse("max_tokens");
    const continuation = await awaitNextStream(mockClient, stream);
    const continuationText = lastUserText(continuation);
    expect(continuationText).toContain("truncated");
    expect(continuationText).not.toContain("XML tags in your response");
  });
});

describe("yield_to_parent as an ordinary tool", () => {
  it("stops the turn over a real tool result, issuing no further request", async () => {
    const { core, mockClient } = createAgentWithMock({
      threadType: "subagent" as ThreadType,
    });
    const sent = core.submit({
      type: "resolved",
      messages: [
        {
          type: "text",
          text: "do the task",
        },
      ],
    });
    const stream = await mockClient.awaitStream();
    stream.streamToolUse(
      "yield-1" as ToolRequestId,
      "yield_to_parent" as ToolName,
      { result: "all done" },
    );
    stream.finishResponse("tool_use");
    expect(await sent).toEqual({
      type: "yielded",
      value: { result: "all done" },
    });
    // The tool really ran, and the loop stopped rather than continuing on the
    // results.
    const last = core.getProviderMessages().at(-1);
    expect(last).toMatchObject({
      role: "user",
      content: [
        { type: "tool_result", id: "yield-1", result: { status: "ok" } },
      ],
    });
    expect(mockClient.streams.length).toBe(1);
  });
  it("runs the tools requested alongside it", async () => {
    const { core, mockClient } = createAgentWithMock({
      threadType: "subagent" as ThreadType,
      fileIO: new InMemoryFileIO({ "/tmp/a.txt": "hello" }),
    });
    const sent = core.submit({
      type: "resolved",
      messages: [
        {
          type: "text",
          text: "do the task",
        },
      ],
    });
    const stream = await mockClient.awaitStream();
    stream.streamToolUse("get-1" as ToolRequestId, "get_files" as ToolName, {
      files: [{ filePath: "/tmp/a.txt" }],
    });
    stream.streamToolUse(
      "yield-1" as ToolRequestId,
      "yield_to_parent" as ToolName,
      { result: "all done" },
    );
    stream.finishResponse("tool_use");
    expect(await sent).toEqual({
      type: "yielded",
      value: { result: "all done" },
    });
    expect(core.getProviderMessages().slice(-2)).toMatchObject([
      {
        content: [
          {
            id: "get-1",
            result: { status: "ok", value: [{}, { text: "hello" }] },
          },
        ],
      },
      { content: [{ id: "yield-1", result: { status: "ok" } }] },
    ]);
  });
  it("wins over a compaction the same turn would otherwise trigger", async () => {
    const { core, mockClient } = createAgentWithMock({
      ...autoCompactSupervisors({ threshold: 100, handoff: "go" }),
      threadType: "subagent" as ThreadType,
    });

    mockClient.mockInputTokenCount = 50;
    const compactions = trackCompactions(core);
    const sent = core.submit({
      type: "resolved",
      messages: [
        {
          type: "text",
          text: "do the task",
        },
      ],
    });
    const stream = await mockClient.awaitStream();
    // Over threshold as of the continuation this turn would otherwise issue.
    mockClient.mockInputTokenCount = 200;
    stream.streamToolUse(
      "yield-1" as ToolRequestId,
      "yield_to_parent" as ToolName,
      { result: "all done" },
    );
    stream.finishResponse("tool_use");
    // The compaction gate belongs to a request that is never issued.
    expect(await sent).toEqual({
      type: "yielded",
      value: { result: "all done" },
    });
    expect(compactions.prompts.length).toBe(0);
  });
  it("does not stop the turn when the call is malformed", async () => {
    const { core, mockClient } = createAgentWithMock({
      threadType: "subagent" as ThreadType,
    });
    void core.submit({
      type: "resolved",
      messages: [
        {
          type: "text",
          text: "do the task",
        },
      ],
    });
    const first = await mockClient.awaitStream();
    first.streamToolUsePartial(
      "yield-bad" as ToolRequestId,
      "yield_to_parent" as ToolName,
      ["[42]"],
    );
    first.finishResponse("tool_use");
    // No structured result, so no suspension: the turn continues with the
    // error result.
    const next = await awaitNextStream(mockClient, first);
    expect(core.yielded).toBeUndefined();
    next.streamText("sorry");
    next.finishResponse("end_turn");
  });
});
describe("Agent.abort on yielded thread", () => {
  it("abort is a no-op when thread has already yielded", async () => {
    const { core, mockClient } = createAgentWithMock({
      threadType: "subagent" as ThreadType,
    });

    void core.submit({
      type: "resolved",
      messages: [
        {
          type: "text",
          text: "do the task",
        },
      ],
    });
    const stream = await mockClient.awaitStream();

    const toolUseId = "tool-yield-1" as ToolRequestId;

    // Drive the thread to yielded state
    stream.streamToolUse(toolUseId, "yield_to_parent" as ToolName, {
      result: "Here is the result of my work",
    });
    stream.finishResponse("tool_use");

    await pollUntil(() => {
      if (core.yielded) return true;
      throw new Error(
        `waiting for yielded mode, currently: ${activityLabel(core.state)}`,
      );
    });

    expect(core.yielded).toBeDefined();

    // Now abort — should be a no-op
    await core.abort();

    // Mode should still be yielded with the original response
    const yielded = core.yielded;
    if (!yielded) throw new Error("expected a yield");
    expect(yielded.value).toEqual({ result: "Here is the result of my work" });
  });

  it("abortAndWait leaves the yield in place", async () => {
    const { core, mockClient } = createAgentWithMock({
      threadType: "subagent" as ThreadType,
    });
    void core.submit({
      type: "resolved",
      messages: [
        {
          type: "text",
          text: "do the task",
        },
      ],
    });
    const stream = await mockClient.awaitStream();
    stream.streamToolUse(
      "tool-yield-2" as ToolRequestId,
      "yield_to_parent" as ToolName,
      {
        result: "all done",
      },
    );
    stream.finishResponse("tool_use");
    await pollUntil(() => {
      if (core.yielded) return true;
      throw new Error(
        `waiting for yielded, currently: ${activityLabel(core.state)}`,
      );
    });
    // `abort()` short-circuits on a yielded agent, but the preempting-send path
    // winds the agent's turn down directly: it must not erase the yield either.
    await core.abort();
    expect(core.yielded).toBeDefined();
    expect(core.lastResult()).toEqual({
      type: "yielded",
      value: { result: "all done" },
    });
  });
});

describe("Agent.abort appends user abort message", () => {
  it("appends abort message when aborting during streaming", async () => {
    const { core, mockClient } = createAgentWithMock();

    void core.submit({
      type: "resolved",
      messages: [
        {
          type: "text",
          text: "hello",
        },
      ],
    });
    const stream = await mockClient.awaitStream();

    // Start streaming text but don't finish
    stream.streamText("Here is a partial response");

    // Abort while streaming
    await core.abort();

    // The last message should be a user message with the abort text
    const messages = core.getProviderMessages();
    const lastMessage = messages[messages.length - 1];
    expect(lastMessage.role).toBe("user");
    expect(lastMessage.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "text",
          text: "[The user aborted the previous request.]",
        }),
      ]),
    );
  });

  it("appends abort message after tool_result errors when aborting during tool_use", async () => {
    // Use a fileIO where stat blocks so the tool stays pending
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
          text: "hello",
        },
      ],
    });
    const stream = await mockClient.awaitStream();

    const toolUseId = "tool-abort-1" as ToolRequestId;

    // Stream a tool_use block and finish with tool_use stop reason
    stream.streamToolUse(toolUseId, "get_files" as ToolName, {
      files: [{ filePath: "/tmp/test.txt" }],
    });
    stream.finishResponse("tool_use");

    // Wait for tool_use mode
    await pollUntil(() => {
      if (activityLabel(core.state) === "running_tools") return true;
      throw new Error(
        `waiting for tool_use mode, currently: ${activityLabel(core.state)}`,
      );
    });

    // Abort while in tool_use mode (tool is still pending)
    const abortPromise = core.abort();
    resolveStat();
    await abortPromise;

    // The last message should be the abort user message
    const messages = core.getProviderMessages();
    const lastMessage = messages[messages.length - 1];
    expect(lastMessage.role).toBe("user");
    expect(lastMessage.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "text",
          text: "[The user aborted the previous request.]",
        }),
      ]),
    );

    // The tool_result error rides the same user message as the abort marker
    expect(lastMessage.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "tool_result",
          id: toolUseId,
        }),
      ]),
    );
  });
});

describe("SubagentSupervisor yield tag detection", () => {
  it("nudges agent when it writes a <yield_to_parent> XML tag instead of calling the tool", async () => {
    const { core, mockClient } = createAgentWithMock({
      submissionSupervisors: [SubagentSupervisor.create()],
      threadType: "subagent" as ThreadType,
    });

    void core.submit({
      type: "resolved",
      messages: [
        {
          type: "text",
          text: "do the task",
        },
      ],
    });
    const stream = await mockClient.awaitStream();

    // Runner writes a <yield> tag in text instead of calling the tool
    stream.streamText(
      "<yield_to_parent>Here is the result of my work</yield_to_parent>",
    );
    stream.finishResponse("end_turn");

    // The supervisor should detect the tag and send a correction message,
    // which triggers a new stream
    const nextStream = await pollUntil(() => {
      const s = mockClient.streams[mockClient.streams.length - 1];
      if (s && s !== stream) return s;
      throw new Error("waiting for next stream");
    });

    // Verify the correction message mentions the yield_to_parent tool
    const lastUserMsg = nextStream.messages[nextStream.messages.length - 1];
    expect(lastUserMsg.role).toBe("user");
    const textBlocks = (
      lastUserMsg.content as Anthropic.Messages.ContentBlockParam[]
    ).filter((b): b is Anthropic.Messages.TextBlockParam => b.type === "text");
    expect(
      textBlocks.some((b) => b.text.includes("yield_to_parent tool")),
    ).toBe(true);
  });

  it("does not intervene when agent stops without a yield tag", async () => {
    const { core, mockClient } = createAgentWithMock({
      submissionSupervisors: [SubagentSupervisor.create()],
      threadType: "subagent" as ThreadType,
    });

    void core.submit({
      type: "resolved",
      messages: [
        {
          type: "text",
          text: "do the task",
        },
      ],
    });
    const stream = await mockClient.awaitStream();

    // Runner responds with normal text and stops
    stream.streamText("I have completed the task.");
    stream.finishResponse("end_turn");

    // Wait a tick to ensure no new stream is created
    await new Promise((r) => setTimeout(r, 50));
    expect(mockClient.streams.length).toBe(1);
  });
});

function countOccurrences(value: unknown, needle: string): number {
  return JSON.stringify(value).split(needle).length - 1;
}

describe("TokenBudget integration", () => {
  it("compacts at the gate of the request whose conversation breaches the threshold", async () => {
    const { core, mockClient } = createAgentWithMock({
      ...autoCompactSupervisors({ threshold: 100, handoff: "go" }),
    });

    mockClient.mockInputTokenCount = 50;

    const compactions = trackCompactions(core);

    void core.submit({
      type: "resolved",
      messages: [
        {
          type: "text",
          text: "hello",
        },
      ],
    });
    const stream = await mockClient.awaitStream();
    stream.streamText("done");
    stream.finishResponse("end_turn");

    await pollUntil(() => {
      if (core.inputTokenCount === 50) return true;
      throw new Error("waiting for the preflight token count");
    });
    expect(compactions.prompts.length).toBe(0);

    // The count is taken before the request it describes, so the very next
    // gate sees the breach — no wasted request goes out first.
    mockClient.mockInputTokenCount = 200;
    void core.submit({
      type: "resolved",
      messages: [
        {
          type: "text",
          text: "again",
        },
      ],
    });

    await pollUntil(() => {
      if (compactions.prompts.length > 0) return true;
      throw new Error("waiting for compaction");
    });

    expect(compactions.prompts.length).toBe(1);
    expect(mockClient.streams.length).toBe(1);
  });

  it("refuses the first request once the count, input included, breaches", async () => {
    const { core, mockClient } = createAgentWithMock({
      ...autoCompactSupervisors({ threshold: 100, handoff: "go" }),
    });
    mockClient.mockInputTokenCount = 200;
    const histories: ProviderMessage[][] = [];
    const release = new Defer<void>();
    compactorSlot(core).compactor = {
      run: (history, next) => {
        histories.push([...history]);
        mockClient.mockInputTokenCount = 10;
        return release.promise.then(() => ({
          type: "complete" as const,
          summary: { text: "SUMMARY", chunkCount: 1 },
          next: [...next],
        }));
      },
    };
    const done = core.submit({
      type: "resolved",
      messages: [{ type: "text", text: "hello" }],
    });
    await pollUntil(() => {
      if (histories.length > 0) return true;
      throw new Error("waiting for compaction");
    });
    const counted = mockClient.countTokensRequests[0].messages;
    expect(JSON.stringify(counted[counted.length - 1])).toContain("hello");
    expect(mockClient.streams.length).toBe(0);
    release.resolve();
    const stream = await mockClient.awaitStream();
    expect(JSON.stringify(stream.params.messages)).toContain("go");
    stream.streamText("ok");
    stream.finishResponse("end_turn");
    expect(await done).toEqual({ type: "completed", stopReason: "end_turn" });
  });
  it("carries a breaching tool batch's results into compaction unsent", async () => {
    const fileIO = new InMemoryFileIO({ "/tmp/a.txt": "hello" });
    const { core, mockClient } = createAgentWithMock({
      ...autoCompactSupervisors({ threshold: 100, handoff: "go" }),
      fileIO: fileIO as unknown as ThreadContext["fileIO"],
    });
    mockClient.mockInputTokenCount = 50;
    const histories: ProviderMessage[][] = [];
    compactorSlot(core).compactor = {
      run: (history, _next) => {
        histories.push([...history]);
        return Promise.resolve({ type: "aborted" });
      },
    };
    void core.submit({
      type: "resolved",
      messages: [{ type: "text", text: "edit a" }],
    });
    const stream = await mockClient.awaitStream();
    mockClient.mockInputTokenCount = 200;
    stream.streamToolUse("edl-1" as ToolRequestId, "edl" as ToolName, {
      script: `file \`/tmp/a.txt\`\nnarrow /hello/\nreplace "bye"`,
    });
    stream.finishResponse("tool_use");
    await pollUntil(() => {
      if (histories.length > 0) return true;
      throw new Error("waiting for compaction");
    });
    expect(
      histories[0].some((m) => m.content.some((c) => c.type === "tool_result")),
    ).toBe(true);
    expect(mockClient.streams.length).toBe(1);
  });
  it("never counts without a budget", async () => {
    const { core, mockClient } = createAgentWithMock();
    const done = core.submit({
      type: "resolved",
      messages: [{ type: "text", text: "hello" }],
    });
    const stream = await mockClient.awaitStream();
    stream.streamText("done");
    stream.finishResponse("end_turn");
    await done;
    expect(mockClient.countTokensCalls).toBe(0);
  });
  it("settles aborted, without compacting, when aborted mid-count", async () => {
    const { core, mockClient } = createAgentWithMock({
      ...autoCompactSupervisors({ threshold: 100, handoff: "go" }),
    });
    mockClient.mockInputTokenCount = 200;
    const gate = new Defer<void>();
    mockClient.countTokensGate = gate.promise;
    const done = core.submit({
      type: "resolved",
      messages: [{ type: "text", text: "hello" }],
    });
    await pollUntil(() => {
      if (mockClient.countTokensCalls > 0) return true;
      throw new Error("waiting for count");
    });
    const aborted = core.abort();
    gate.resolve();
    await aborted;
    expect(await done).toEqual({ type: "aborted" });
    expect(mockClient.streams.length).toBe(0);
  });
  it("never lets context_budget reach turn supervisors or the submitter", async () => {
    const seen: string[] = [];
    const { core, mockClient } = createAgentWithMock({
      ...autoCompactSupervisors({ threshold: 100, handoff: "go" }, [
        {
          onToolLoopEnd: (ctx) => {
            seen.push(ctx.stopReason);
            return { type: "none" };
          },
        },
      ]),
    });
    mockClient.mockInputTokenCount = 200;
    compactorSlot(core).compactor = {
      run: (_messages, next) => {
        mockClient.mockInputTokenCount = 10;
        return Promise.resolve({
          type: "complete" as const,
          summary: { text: "SUMMARY", chunkCount: 1 },
          next: [...next],
        });
      },
    };
    const result = core.submit({
      type: "resolved",
      messages: [{ type: "text", text: "hello" }],
    });
    const stream = await mockClient.awaitStream();
    stream.finishResponse("end_turn");
    expect(await result).toEqual({ type: "completed", stopReason: "end_turn" });
    expect(seen).not.toContain("context_budget");
  });
  it("does not trigger compaction when input tokens are below the threshold", async () => {
    const { core, mockClient } = createAgentWithMock({
      ...autoCompactSupervisors({ threshold: 100000, handoff: "go" }),
    });

    mockClient.mockInputTokenCount = 50;

    const compactions = trackCompactions(core);

    void core.submit({
      type: "resolved",
      messages: [
        {
          type: "text",
          text: "hello",
        },
      ],
    });
    const stream = await mockClient.awaitStream();
    stream.streamText("done");
    stream.finishResponse("end_turn", { inputTokens: 50, outputTokens: 5 });

    await pollUntil(() => {
      if (flatLoop(core).type !== "idle") throw new Error("waiting");
      return true;
    });

    expect(compactions.prompts.length).toBe(0);
  });

  it("triggers compaction on a tool_use handoff after tools resolve", async () => {
    const fileIO = new InMemoryFileIO({ "/tmp/a.txt": "hello" });
    const { core, mockClient } = createAgentWithMock({
      ...autoCompactSupervisors({ threshold: 100, handoff: "go" }),
      fileIO: fileIO as unknown as ThreadContext["fileIO"],
    });

    mockClient.mockInputTokenCount = 50;

    const compactions = trackCompactions(core);

    // The turn ends with a tool_use; the continuation that would carry the
    // tool results is gated, and its count is over threshold.
    void core.submit({
      type: "resolved",
      messages: [
        {
          type: "text",
          text: "edit a",
        },
      ],
    });
    const stream2 = await mockClient.awaitStream();
    mockClient.mockInputTokenCount = 200;
    stream2.streamToolUse("edl-1" as ToolRequestId, "edl" as ToolName, {
      script: `file \`/tmp/a.txt\`\nnarrow /hello/\nreplace "bye"`,
    });
    stream2.finishResponse("tool_use");

    await pollUntil(() => {
      if (compactions.prompts.length > 0) return true;
      throw new Error("waiting for compaction");
    });
    expect(compactions.prompts.length).toBe(1);
  });

  it("compacts at the gate of the continuation a max_tokens stop asks for", async () => {
    const { core, mockClient } = createAgentWithMock({
      ...autoCompactSupervisors({ threshold: 100, handoff: "go" }, [
        MaxTokensSupervisor.create(),
      ]),
    });

    mockClient.mockInputTokenCount = 50;

    const compactions = trackCompactions(core);

    // A max_tokens stop without a tool_use block continues with a
    // continue-prompt; that continuation's gate sees the breach.
    void core.submit({
      type: "resolved",
      messages: [
        {
          type: "text",
          text: "again",
        },
      ],
    });
    const stream2 = await mockClient.awaitStream();
    mockClient.mockInputTokenCount = 200;
    stream2.streamText("partial");
    stream2.finishResponse("max_tokens");

    await pollUntil(() => {
      if (compactions.prompts.length > 0) return true;
      throw new Error("waiting for compaction");
    });
    expect(compactions.prompts.length).toBe(1);
  });

  it("appends an injected text to the message log", async () => {
    const { core, mockClient } = createAgentWithMock({
      toolLoopSupervisors: [
        {
          onBeforeRequest: () => {
            if (injected) return Promise.resolve({ type: "none" as const });
            injected = true;
            return Promise.resolve(injectText("remember this"));
          },
        },
      ],
    });
    let injected = false;

    void core.submit({
      type: "resolved",
      messages: [
        {
          type: "text",
          text: "hello",
        },
      ],
    });
    const stream = await mockClient.awaitStream();
    stream.streamText("done");
    stream.finishResponse("end_turn");
    await pollUntil(() => {
      if (injected) return true;
      throw new Error("waiting for injection");
    });
    void core.submit({
      type: "resolved",
      messages: [
        {
          type: "text",
          text: "next",
        },
      ],
    });
    const stream2 = await awaitNextStream(mockClient, stream);
    expect(JSON.stringify(stream2.messages)).toContain("remember this");
    stream2.streamText("ok");
    stream2.finishResponse("end_turn");
  });

  it("injects an image on the tool_use continuation, after the tool result", async () => {
    const fileIO = new InMemoryFileIO({ "/tmp/a.txt": "hello" });
    const { core, mockClient } = createAgentWithMock({
      toolLoopSupervisors: [
        {
          onBeforeRequest: () => {
            // The opening request is skipped: the injection belongs on the
            // continuation that carries the tool result.
            requests++;
            if (injected || requests === 1) {
              return Promise.resolve({ type: "none" as const });
            }
            injected = true;
            return Promise.resolve({
              type: "inject" as const,
              content: [
                {
                  type: "image" as const,
                  source: {
                    type: "base64" as const,
                    media_type: "image/png" as const,
                    data: "aW1n",
                  },
                },
              ],
            });
          },
        },
      ],
      fileIO: fileIO as unknown as ThreadContext["fileIO"],
    });
    let injected = false;
    let requests = 0;

    void core.submit({
      type: "resolved",
      messages: [
        {
          type: "text",
          text: "edit a",
        },
      ],
    });
    const stream = await mockClient.awaitStream();
    stream.streamToolUse("edl-1" as ToolRequestId, "edl" as ToolName, {
      script: `file \`/tmp/a.txt\`\nnarrow /hello/\nreplace "bye"`,
    });
    stream.finishResponse("tool_use");
    const stream2 = await awaitNextStream(mockClient, stream);
    const blocks = stream2.messages[stream2.messages.length - 1]
      .content as Anthropic.ContentBlockParam[];
    expect(blocks[0].type).toBe("tool_result");
    expect(blocks.map((b) => b.type)).toContain("image");
    stream2.streamText("ok");
    stream2.finishResponse("end_turn");
  });
  it("keeps the injection in the log when a compaction follows it", async () => {
    const { core, mockClient } = createAgentWithMock({
      toolLoopSupervisors: [
        // max_tokens plans a continuation, so the stop reaches the
        // before-request supervisors at all.
        {
          onBeforeRequest: () => {
            // The opening request of the send is skipped; the note rides the
            // continuation the max_tokens nudge produces.
            requests++;
            if (asked || requests === 1)
              return Promise.resolve({ type: "none" as const });
            asked = true;
            mockClient.mockInputTokenCount = 200;
            return Promise.resolve(injectText("note"));
          },
        },
      ],
      ...autoCompactSupervisors({ threshold: 100, handoff: "carry on" }, [
        MaxTokensSupervisor.create(),
      ]),
    });
    let asked = false;
    let requests = 0;

    const compactions = trackCompactions(core);
    void core.submit({
      type: "resolved",
      messages: [
        {
          type: "text",
          text: "hello",
        },
      ],
    });
    const stream = await mockClient.awaitStream();
    stream.streamText("partial");
    stream.finishResponse("max_tokens");
    await pollUntil(() => {
      if (compactions.prompts.length > 0) return true;
      throw new Error("waiting for compaction");
    });
    expect(compactions.prompts.length).toBe(1);
    // Thread hands over only the handoff; carrying the unanswered tail is the
    // compactor's job (see compaction/index.test.ts).
    expect(compactions.prompts[0]).toBe("carry on");
    // Exactly once: the snapshot handed to the compaction manager is
    // `getProviderMessages()`, and nothing is left in agent-local state that
    // the swap would either drop or replay.
    expect(countOccurrences(core.getProviderMessages(), "note")).toBe(1);
  });
  it("appends a tool_use-path injection immediately when a compaction follows", async () => {
    const fileIO = new InMemoryFileIO({ "/tmp/a.txt": "hello" });
    const { core, mockClient } = createAgentWithMock({
      toolLoopSupervisors: [
        {
          onBeforeRequest: () => {
            requests++;
            if (asked || requests === 1) {
              return Promise.resolve({ type: "none" as const });
            }
            asked = true;
            mockClient.mockInputTokenCount = 200;
            return Promise.resolve(injectText("tool-path note"));
          },
        },
      ],
      ...autoCompactSupervisors({ threshold: 100, handoff: "carry on" }),
      fileIO: fileIO as unknown as ThreadContext["fileIO"],
    });
    let asked = false;
    let requests = 0;

    const compactions = trackCompactions(core);
    void core.submit({
      type: "resolved",
      messages: [
        {
          type: "text",
          text: "edit a",
        },
      ],
    });
    const stream = await mockClient.awaitStream();
    stream.streamToolUse("edl-1" as ToolRequestId, "edl" as ToolName, {
      script: `file \`/tmp/a.txt\`\nnarrow /hello/\nreplace "bye"`,
    });
    stream.finishResponse("tool_use");
    await pollUntil(() => {
      if (compactions.prompts.length > 0) return true;
      throw new Error("waiting for compaction");
    });
    expect(countOccurrences(core.getProviderMessages(), "tool-path note")).toBe(
      1,
    );
  });
  it("keeps an injection in the log when the next request fails", async () => {
    const { core, mockClient } = createAgentWithMock({
      toolLoopSupervisors: [
        {
          onBeforeRequest: () => {
            if (injected) return Promise.resolve({ type: "none" as const });
            injected = true;
            return Promise.resolve(injectText("survive the failure"));
          },
        },
      ],
    });
    let injected = false;

    void core.submit({
      type: "resolved",
      messages: [
        {
          type: "text",
          text: "hello",
        },
      ],
    });
    const stream = await mockClient.awaitStream();
    stream.streamText("done");
    stream.finishResponse("end_turn");
    await pollUntil(() => {
      if (injected) return true;
      throw new Error("waiting for injection");
    });
    void core.submit({
      type: "resolved",
      messages: [
        {
          type: "text",
          text: "next",
        },
      ],
    });
    const stream2 = await awaitNextStream(mockClient, stream);
    stream2.respondWithError(new Error("provider failure"));
    await pollUntil(() => {
      if (core.state.type === "idle") return true;
      throw new Error("waiting for idle");
    });
    expect(
      countOccurrences(core.getProviderMessages(), "survive the failure"),
    ).toBe(1);
    void core.submit({
      type: "resolved",
      messages: [
        {
          type: "text",
          text: "retry",
        },
      ],
    });
    const stream3 = await awaitNextStream(mockClient, stream2);
    expect(countOccurrences(stream3.messages, "survive the failure")).toBe(1);
    stream3.streamText("ok");
    stream3.finishResponse("end_turn");
  });
  it("keeps an injection in the log when the next request is aborted", async () => {
    const { core, mockClient } = createAgentWithMock({
      toolLoopSupervisors: [
        {
          onBeforeRequest: () => {
            if (injected) return Promise.resolve({ type: "none" as const });
            injected = true;
            return Promise.resolve(injectText("survive the abort"));
          },
        },
      ],
    });
    let injected = false;

    void core.submit({
      type: "resolved",
      messages: [
        {
          type: "text",
          text: "hello",
        },
      ],
    });
    const stream = await mockClient.awaitStream();
    stream.streamText("done");
    stream.finishResponse("end_turn");
    await pollUntil(() => {
      if (injected) return true;
      throw new Error("waiting for injection");
    });
    void core.submit({
      type: "resolved",
      messages: [
        {
          type: "text",
          text: "next",
        },
      ],
    });
    const stream2 = await awaitNextStream(mockClient, stream);
    stream2.streamText("partial");
    await core.abort();
    await pollUntil(() => {
      if (core.state.type === "idle") return true;
      throw new Error("waiting for idle");
    });
    expect(
      countOccurrences(core.getProviderMessages(), "survive the abort"),
    ).toBe(1);
    void core.submit({
      type: "resolved",
      messages: [
        {
          type: "text",
          text: "retry",
        },
      ],
    });
    const stream3 = await awaitNextStream(mockClient, stream2);
    expect(countOccurrences(stream3.messages, "survive the abort")).toBe(1);
    stream3.streamText("ok");
    stream3.finishResponse("end_turn");
  });

  it("consults all supervisors in order and joins their nudges", async () => {
    const first: SubmissionSupervisor = {
      onToolLoopEnd: () => {
        calls.push("first");
        return { type: "none" };
      },
    };
    const second: SubmissionSupervisor = {
      onToolLoopEnd: () => {
        calls.push("second");
        return calls.length > 3
          ? { type: "none" }
          : { type: "send-message", text: "go" };
      },
    };
    const third: SubmissionSupervisor = {
      onToolLoopEnd: () => {
        calls.push("third");
        return calls.length > 3
          ? { type: "none" }
          : { type: "send-message", text: "stop" };
      },
    };
    const { core, mockClient } = createAgentWithMock({
      submissionSupervisors: [first, second, third],
    });
    const calls: string[] = [];

    void core.submit({
      type: "resolved",
      messages: [
        {
          type: "text",
          text: "hello",
        },
      ],
    });
    const stream = await mockClient.awaitStream();
    stream.streamText("done");
    stream.finishResponse("end_turn");

    await pollUntil(() => {
      if (calls.includes("third")) return true;
      throw new Error("waiting for supervisor consultation");
    });

    expect(calls).toEqual(["first", "second", "third"]);
    const next = await awaitNextStream(mockClient, stream);
    expect(JSON.stringify(next.messages)).toContain("go\\n\\nstop");
  });

  it("injects on the opening request of a send, ahead of the user content", async () => {
    const { core, mockClient } = createAgentWithMock({
      toolLoopSupervisors: [
        {
          onBeforeRequest: () => {
            requests++;
            return Promise.resolve(
              requests === 1
                ? injectText("submission note")
                : { type: "none" as const },
            );
          },
        },
      ],
    });
    let requests = 0;

    void core.submit({
      type: "resolved",
      messages: [
        {
          type: "text",
          text: "hello",
        },
      ],
    });
    const stream = await mockClient.awaitStream();

    expect(requests).toBe(1);
    const serialized = JSON.stringify(stream.messages);
    expect(serialized).toContain("submission note");
    expect(serialized.indexOf("submission note")).toBeLessThan(
      serialized.indexOf("hello"),
    );

    stream.streamText("ok");
    stream.finishResponse("end_turn");
  });

  it("consults onBeforeRequest exactly once per request across a handoff", async () => {
    const { core, mockClient } = createAgentWithMock({
      submissionSupervisors: [MaxTokensSupervisor.create()],
      toolLoopSupervisors: [
        {
          onBeforeRequest: () => {
            requests++;
            return Promise.resolve({ type: "none" as const });
          },
        },
      ],
    });
    let requests = 0;

    void core.submit({
      type: "resolved",
      messages: [
        {
          type: "text",
          text: "hello",
        },
      ],
    });
    const stream = await mockClient.awaitStream();
    stream.streamText("truncated");
    stream.finishResponse("max_tokens");

    // handleStopped consults, then issues the continue-prompt request itself:
    // that request must not be consulted a second time.
    const nextStream = await pollUntil(() => {
      const s = mockClient.streams[mockClient.streams.length - 1];
      if (s && s !== stream) return s;
      throw new Error("waiting for the continuation request");
    });
    nextStream.streamText("done");
    nextStream.finishResponse("end_turn");

    await pollUntil(() => {
      if (!core.isBusy) return true;
      throw new Error("waiting for the thread to come to rest");
    });
    expect(requests).toBe(2);
  });
  it("does not consult onBeforeRequest at a stop that issues no request", async () => {
    const { core, mockClient } = createAgentWithMock({
      toolLoopSupervisors: [
        {
          onBeforeRequest: () => {
            requests++;
            return Promise.resolve({ type: "none" as const });
          },
        },
      ],
    });
    let requests = 0;

    void core.submit({
      type: "resolved",
      messages: [
        {
          type: "text",
          text: "hello",
        },
      ],
    });
    const stream = await mockClient.awaitStream();
    // A queued async message means the end_turn stop still issues a request.
    core.enqueue(
      {
        type: "resolved",
        messages: [
          {
            type: "text",
            text: "and this",
          },
        ],
      },
      "async",
    );
    stream.streamText("ok");
    stream.finishResponse("end_turn");
    const nextStream = await awaitNextStream(mockClient, stream);
    expect(requests).toBe(2);
    // This stop has nothing left to send.
    nextStream.streamText("done");
    nextStream.finishResponse("end_turn");
    await pollUntil(() => {
      if (!core.isBusy) return true;
      throw new Error("waiting for the thread to come to rest");
    });
    expect(requests).toBe(2);
  });

  it("reports tool results before the continuation's before-request hook, with output tokens", async () => {
    const { core, mockClient } = createAgentWithMock({
      toolLoopSupervisors: [
        {
          onToolResults: (results) => {
            events.push(`results:${results.size}`);
          },
          onBeforeRequest: (ctx) => {
            events.push("request");
            requests++;
            // Only a continuation has a finished assistant message behind it.
            if (requests > 1) {
              continuationOutputTokens = ctx.outputTokenCount;
            }
            return Promise.resolve({ type: "none" as const });
          },
          hasPendingContent: () => Promise.resolve(false),
        },
      ],
    });
    const events: string[] = [];
    let continuationOutputTokens: number | undefined;
    let requests = 0;

    void core.submit({
      type: "resolved",
      messages: [
        {
          type: "text",
          text: "hello",
        },
      ],
    });
    const stream = await mockClient.awaitStream();
    stream.streamToolUse("edl-1" as ToolRequestId, "edl" as ToolName, {
      script: "nonsense",
    });
    stream.finishResponse("tool_use", { inputTokens: 1, outputTokens: 42 });
    const nextStream = await awaitNextStream(mockClient, stream);
    expect(events).toEqual(["request", "results:1", "request"]);
    expect(continuationOutputTokens).toBe(42);
    // A second tool turn: the count accumulates across finished assistant
    // messages, and the in-flight one (no usage yet) contributes nothing.
    nextStream.streamToolUse("edl-2" as ToolRequestId, "edl" as ToolName, {
      script: "nonsense",
    });
    nextStream.finishResponse("tool_use", { inputTokens: 1, outputTokens: 8 });
    const thirdStream = await awaitNextStream(mockClient, nextStream);
    expect(continuationOutputTokens).toBe(50);
    thirdStream.streamText("done");
    thirdStream.finishResponse("end_turn");
  });
  it("reports tool results even when the turn aborts instead of continuing", async () => {
    let resolveStat!: () => void;
    const statPromise = new Promise<{ mtimeMs: number; size: number }>(
      (resolve) => {
        resolveStat = () => resolve({ mtimeMs: 0, size: 100 });
      },
    );
    const { core, mockClient } = createAgentWithMock({
      toolLoopSupervisors: [
        {
          onToolResults: (results) => {
            events.push(`results:${results.size}`);
          },
          onBeforeRequest: () => {
            events.push("request");
            return Promise.resolve({ type: "none" as const });
          },
          hasPendingContent: () => Promise.resolve(false),
        },
      ],
      fileIO: {
        readFile: async () => "file contents",
        writeFile: async () => {},
        fileExists: async () => true,
        stat: async () => statPromise,
      } as unknown as ThreadContext["fileIO"],
    });
    const events: string[] = [];

    void core.submit({
      type: "resolved",
      messages: [
        {
          type: "text",
          text: "hello",
        },
      ],
    });
    const stream = await mockClient.awaitStream();
    stream.streamToolUse("get-1" as ToolRequestId, "get_files" as ToolName, {
      files: [{ filePath: "/tmp/test.txt" }],
    });
    stream.finishResponse("tool_use");
    await pollUntil(() => {
      if (activityLabel(core.state) === "running_tools") return true;
      throw new Error(
        `waiting for tool_use mode, currently: ${activityLabel(core.state)}`,
      );
    });
    const abortPromise = core.abort();
    resolveStat();
    await abortPromise;
    // The results are reported, and no continuation request follows them.
    expect(events).toEqual(["request", "results:1"]);
  });
  it("reports tool results when the turn yields instead of continuing", async () => {
    const { core, mockClient } = createAgentWithMock({
      toolLoopSupervisors: [
        {
          onToolResults: (results) => {
            events.push(`results:${results.size}`);
          },
          onBeforeRequest: () => {
            events.push("request");
            return Promise.resolve({ type: "none" as const });
          },
          hasPendingContent: () => Promise.resolve(false),
        },
      ],
      threadType: "subagent",
    });
    const events: string[] = [];

    void core.submit({
      type: "resolved",
      messages: [
        {
          type: "text",
          text: "hello",
        },
      ],
    });
    const stream = await mockClient.awaitStream();
    stream.streamToolUse(
      "yield-1" as ToolRequestId,
      "yield_to_parent" as ToolName,
      { result: "all done" },
    );
    stream.finishResponse("tool_use");
    await pollUntil(() => {
      if (core.yielded) return true;
      throw new Error(
        `waiting for yielded mode, currently: ${activityLabel(core.state)}`,
      );
    });
    expect(events).toEqual(["request", "results:1"]);
  });

  it("drops a submission aborted while its before-request hooks are in flight", async () => {
    const { core, mockClient } = createAgentWithMock({
      toolLoopSupervisors: [
        {
          onBeforeRequest: async () => {
            await gate.promise;
            return injectText("late note");
          },
        },
      ],
    });
    const gate = new Defer<void>();

    const sent = core.submit({
      type: "resolved",
      messages: [
        {
          type: "text",
          text: "hello",
        },
      ],
    });
    // The gate runs inside the turn, so the abort joins on it: resolve it
    // before awaiting, or the two wait on each other.
    const aborted = core.abort();
    gate.resolve();
    await aborted;
    expect(await sent).toEqual({ type: "aborted" });
    await delay(10);
    expect(mockClient.streams.length).toBe(0);
  });
  it("issues a request for a submission-time injection with no user content", async () => {
    const { core, mockClient } = createAgentWithMock({
      toolLoopSupervisors: [
        {
          hasPendingContent: () => Promise.resolve(true),
          onBeforeRequest: () => Promise.resolve(injectText("solo note")),
        },
      ],
    });

    void core.submit({ type: "resolved", messages: [] });
    const stream = await mockClient.awaitStream();
    expect(JSON.stringify(stream.messages)).toContain("solo note");
    stream.streamText("ok");
    stream.finishResponse("end_turn");
  });

  it("compacts from a plain send, exactly once, when already over threshold", async () => {
    const { core, mockClient } = createAgentWithMock({
      ...autoCompactSupervisors({ threshold: 100, handoff: "go" }),
    });

    mockClient.mockInputTokenCount = 200;

    const compactions = trackCompactions(core);

    // The send is over threshold before its first request goes out, so the
    // gate compacts instead of issuing it — once, and with no request.
    void core.submit({
      type: "resolved",
      messages: [
        {
          type: "text",
          text: "again",
        },
      ],
    });
    await pollUntil(() => {
      if (compactions.prompts.length > 0) return true;
      throw new Error("waiting for the submission compaction");
    });
    expect(compactions.prompts.length).toBe(1);
    expect(mockClient.streams.length).toBe(0);
    // The user's message is in the log the compaction snapshot is taken from.
    expect(JSON.stringify(core.getProviderMessages())).toContain("again");
  });
});

describe("Thread.onToolApplied", () => {
  it("fires for edl edits and get_files reads, alongside editedFileGroups", async () => {
    const fileIO = new InMemoryFileIO({
      "/tmp/a.txt": "hello",
      "/tmp/b.txt": "other",
    });
    const collector = (supervisor: number): ToolLoopSupervisor => ({
      onToolApplied: ({ absFilePath, tool }) => {
        applied.push({ supervisor, path: absFilePath, type: tool.type });
      },
    });
    const { core, mockClient } = createAgentWithMock({
      toolLoopSupervisors: [collector(0), collector(1)],
      fileIO: fileIO as unknown as ThreadContext["fileIO"],
    });
    const applied: {
      supervisor: number;
      path: AbsFilePath;
      type: ToolApplied["type"];
    }[] = [];

    void core.submit({
      type: "resolved",
      messages: [
        {
          type: "text",
          text: "edit a",
        },
      ],
    });
    const stream = await mockClient.awaitStream();
    stream.streamToolUse("edl-1" as ToolRequestId, "edl" as ToolName, {
      script: `file \`/tmp/a.txt\`\nnarrow /hello/\nreplace "bye"`,
    });
    stream.finishResponse("tool_use");

    const stream2 = await awaitNextStream(mockClient, stream);
    stream2.streamToolUse("get-1" as ToolRequestId, "get_files" as ToolName, {
      files: [{ filePath: "/tmp/b.txt" }],
    });
    stream2.finishResponse("tool_use");

    await pollUntil(() => {
      if (applied.length === 4) return true;
      throw new Error(
        `waiting for 4 onToolApplied calls, got ${applied.length}`,
      );
    });
    expect(applied).toEqual([
      { supervisor: 0, path: "/tmp/a.txt", type: "edl-edit" },
      { supervisor: 1, path: "/tmp/a.txt", type: "edl-edit" },
      { supervisor: 0, path: "/tmp/b.txt", type: "get-file" },
      { supervisor: 1, path: "/tmp/b.txt", type: "get-file" },
    ]);
    expect(core.editedFileGroups[0].files).toEqual([
      { path: "/tmp/a.txt", snapshot: "hello", content: "bye" },
    ]);
  });

  it("keeps editedFileGroups bookkeeping when a subscriber throws", async () => {
    const fileIO = new InMemoryFileIO({ "/tmp/a.txt": "hello" });
    const { core, mockClient } = createAgentWithMock({
      toolLoopSupervisors: [
        {
          onToolApplied: () => {
            throw new Error("subscriber blew up");
          },
        },
      ],
      fileIO: fileIO as unknown as ThreadContext["fileIO"],
    });

    void core.submit({
      type: "resolved",
      messages: [
        {
          type: "text",
          text: "edit a",
        },
      ],
    });
    const stream = await mockClient.awaitStream();
    stream.streamToolUse("edl-1" as ToolRequestId, "edl" as ToolName, {
      script: `file \`/tmp/a.txt\`\nnarrow /hello/\nreplace "bye"`,
    });
    stream.finishResponse("tool_use");

    await pollUntil(() => {
      if (core.editedFileGroups[0]?.files.length === 1) return true;
      throw new Error("waiting for the edited-file bookkeeping");
    });
    expect(core.editedFileGroups[0].files).toEqual([
      { path: "/tmp/a.txt", snapshot: "hello", content: "bye" },
    ]);
  });
});
describe("Thread.editedFileGroups", () => {
  const edit = (
    stream: Awaited<ReturnType<MockAnthropicClient["awaitStream"]>>,
    id: string,
    before: string,
    after: string,
  ) => {
    stream.streamToolUse(id as ToolRequestId, "edl" as ToolName, {
      script: `file \`/tmp/a.txt\`\nnarrow /${before}/\nreplace "${after}"`,
    });
    stream.finishResponse("tool_use");
  };

  it("retains completed loops, including empty loops, and the first snapshot with latest content", async () => {
    const fileIO = new InMemoryFileIO({ "/tmp/a.txt": "hello" });
    const { core, mockClient } = createAgentWithMock({
      fileIO: fileIO as unknown as ThreadContext["fileIO"],
    });
    expect(core.editedFileGroups).toEqual([]);
    const first = core.submit({
      type: "resolved",
      messages: userInput("edit twice"),
    });
    const stream = await mockClient.awaitStream();
    edit(stream, "edit-1", "hello", "bye");
    const second = await awaitNextStream(mockClient, stream);
    edit(second, "edit-2", "bye", "done");
    const third = await awaitNextStream(mockClient, second);
    expect(core.editedFileGroups[0].endNativeMessageIdx).toBeUndefined();
    third.streamText("done");
    third.finishResponse("end_turn");
    expect(await first).toEqual({ type: "completed", stopReason: "end_turn" });
    const firstGroup = core.editedFileGroups[0];
    expect(firstGroup.files).toEqual([
      { path: "/tmp/a.txt", snapshot: "hello", content: "done" },
    ]);
    expect(firstGroup.endNativeMessageIdx).toBe(
      core["core"].manager.getNativeMessageIdx(),
    );

    const next = core.submit({
      type: "resolved",
      messages: userInput("edit again"),
    });
    const fourth = await awaitNextStream(mockClient, third);
    edit(fourth, "edit-3", "done", "final");
    const fifth = await awaitNextStream(mockClient, fourth);
    fifth.streamText("done");
    fifth.finishResponse("end_turn");
    await next;
    const empty = core.submit({
      type: "resolved",
      messages: userInput("no edits"),
    });
    const sixth = await awaitNextStream(mockClient, fifth);
    sixth.streamText("done");
    sixth.finishResponse("end_turn");
    await empty;
    expect(core.editedFileGroups).toHaveLength(3);
    expect(core.editedFileGroups[0]).toEqual(firstGroup);
    expect(core.editedFileGroups[1].files).toEqual([
      { path: "/tmp/a.txt", snapshot: "done", content: "final" },
    ]);
    expect(core.editedFileGroups[2].files).toEqual([]);
    expect(new Set(core.editedFileGroups.map((group) => group.id)).size).toBe(
      3,
    );
    expect(core.editedFileGroups[1].startNativeMessageIdx).toBeGreaterThan(
      firstGroup.endNativeMessageIdx!,
    );
    expect(core.editedFileGroups[2].endNativeMessageIdx).toBe(
      core["core"].manager.getNativeMessageIdx(),
    );
  });

  it.each([
    false,
    true,
  ])("closes an aborted loop at the final abort marker (edited: %s)", async (edited) => {
    const fileIO = new InMemoryFileIO({ "/tmp/a.txt": "hello" });
    const { core, mockClient } = createAgentWithMock({
      fileIO: fileIO as unknown as ThreadContext["fileIO"],
    });
    const turn = core.submit({ type: "resolved", messages: userInput("edit") });
    let stream = await mockClient.awaitStream();
    if (edited) {
      edit(stream, "edit-1", "hello", "bye");
      stream = await awaitNextStream(mockClient, stream);
    }
    core.abort();
    expect(await turn).toEqual({ type: "aborted" });
    const group = core.editedFileGroups[0];
    expect(group.endNativeMessageIdx).toBe(
      core["core"].manager.getNativeMessageIdx(),
    );
    expect(group.files).toEqual(
      edited ? [{ path: "/tmp/a.txt", snapshot: "hello", content: "bye" }] : [],
    );
    expect(JSON.stringify(core.getProviderMessages().at(-1))).toContain(
      ABORT_MARKER_TEXT,
    );
    core.abort();
    expect(core.editedFileGroups).toEqual([group]);
    const next = core.submit({
      type: "resolved",
      messages: userInput("continue"),
    });
    const nextStream = await awaitNextStream(mockClient, stream);
    nextStream.streamText("done");
    nextStream.finishResponse("end_turn");
    await next;
    expect(core.editedFileGroups[0]).toEqual(group);
    expect(
      core.editedFileGroups[1].startNativeMessageIdx,
    ).toBeGreaterThanOrEqual(group.endNativeMessageIdx!);
  });

  it.each([
    false,
    true,
  ])("clones edit history independently at a full or mid-loop boundary (mid-loop: %s)", async (midLoop) => {
    const parentId = uniqueThreadId("edits-parent");
    const childId = uniqueThreadId("edits-child");
    const fileIO = new InMemoryFileIO({ "/tmp/a.txt": "hello" });
    const {
      core: parent,
      mockClient,
      context,
    } = createAgentWithMock(
      { fileIO: fileIO as unknown as ThreadContext["fileIO"] },
      parentId,
    );
    let child: Thread | undefined;
    try {
      const turn = parent.submit({
        type: "resolved",
        messages: userInput("edit twice"),
      });
      const stream = await mockClient.awaitStream();
      edit(stream, "edit-1", "hello", "bye");
      const second = await awaitNextStream(mockClient, stream);
      const midpoint = parent["core"].manager.getNativeMessageIdx();
      edit(second, "edit-2", "bye", "done");
      const third = await awaitNextStream(mockClient, second);
      third.streamText("done");
      third.finishResponse("end_turn");
      await turn;
      const parentHistory = parent.editedFileGroups;
      const nativeMessageIdx = midLoop
        ? midpoint
        : parent["core"].manager.getNativeMessageIdx();
      child = await cloneThread({
        sourceThread: parent,
        newId: childId,
        nativeMessageIdx,
        context: context,
        callbacks: { onUpdate: () => {} },
      });
      expect(child.editedFileGroups).toEqual([
        {
          ...parentHistory[0],
          endNativeMessageIdx: midLoop
            ? midpoint
            : parentHistory[0].endNativeMessageIdx,
          files: [
            {
              path: "/tmp/a.txt",
              snapshot: "hello",
              content: midLoop ? "bye" : "done",
            },
          ],
        },
      ]);
      const inherited = child.editedFileGroups[0];
      const childTurn = child.submit({
        type: "resolved",
        messages: userInput("child edit"),
      });
      const fourth = await awaitNextStream(mockClient, third);
      edit(fourth, "child-edit", "done", "child");
      const fifth = await awaitNextStream(mockClient, fourth);
      fifth.streamText("done");
      fifth.finishResponse("end_turn");
      await childTurn;
      expect(parent.editedFileGroups).toEqual(parentHistory);
      expect(child.editedFileGroups[0]).toEqual(inherited);
      expect(child.editedFileGroups[1].files).toEqual([
        { path: "/tmp/a.txt", snapshot: "done", content: "child" },
      ]);
      const childHistory = child.editedFileGroups;
      const parentTurn = parent.submit({
        type: "resolved",
        messages: userInput("parent edit"),
      });
      const sixth = await awaitNextStream(mockClient, fifth);
      edit(sixth, "parent-edit", "child", "parent");
      const seventh = await awaitNextStream(mockClient, sixth);
      seventh.streamText("done");
      seventh.finishResponse("end_turn");
      await parentTurn;
      expect(child.editedFileGroups).toEqual(childHistory);
      expect(parent.editedFileGroups[0]).toEqual(parentHistory[0]);
      expect(parent.editedFileGroups[1].files).toEqual([
        { path: "/tmp/a.txt", snapshot: "child", content: "parent" },
      ]);
    } finally {
      await parent.destroy();
      if (child) await child.destroy();
      await cleanupArchive(parentId);
      await cleanupArchive(childId);
    }
  });
});

function createMockShell(initialResult: ShellResult): {
  shell: Shell;
  setNextResult: (r: ShellResult) => void;
} {
  let nextResult = initialResult;
  const shell: Shell = {
    execute: (
      _command: string,
      opts: {
        toolRequestId: string;
        onOutput?: (line: OutputLine) => void;
        onStart?: () => void;
      },
    ) => {
      opts.onStart?.();
      for (const line of nextResult.output) {
        opts.onOutput?.(line);
      }
      return Promise.resolve(nextResult);
    },
    terminate: vi.fn(),
  };
  return {
    shell,
    setNextResult: (r) => {
      nextResult = r;
    },
  };
}

function findBashReminderText(
  messages: Anthropic.MessageParam[],
): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "user" || typeof msg.content === "string") continue;
    for (const block of msg.content as Anthropic.ContentBlockParam[]) {
      if (
        block.type === "text" &&
        block.text.includes("<system-reminder>") &&
        block.text.includes("log file") &&
        block.text.includes("bash_summarizer")
      ) {
        return block.text;
      }
    }
  }
  return undefined;
}

function makeAbbreviatedShellResult(): ShellResult {
  const lineContent = "X".repeat(500);
  const output: OutputLine[] = Array.from({ length: 100 }, (_, i) => ({
    stream: "stdout" as const,
    text: `LINE${i + 1}:${lineContent}`,
  }));
  return {
    exitCode: 0,
    signal: undefined,
    output,
    logFilePath: "/tmp/test.log",
    durationMs: 50,
  };
}

describe("structured tool result ownership", () => {
  it("records the structured payload on the thread, keeping it out of the messages", async () => {
    const { shell } = createMockShell(makeAbbreviatedShellResult());
    const { core, mockClient } = createAgentWithMock({
      shell: shell as unknown as ClientToolContext["shell"],
    });
    const requestId = "tool-bash-1" as ToolRequestId;
    void core.submit({
      type: "resolved",
      messages: [
        {
          type: "text",
          text: "run a thing",
        },
      ],
    });
    const stream = await mockClient.awaitStream();
    stream.streamToolUse(requestId, "bash_command" as ToolName, {
      command: "echo hi",
    });
    stream.finishResponse("tool_use");
    const structured = await pollUntil(() => {
      const entry = core.completedTools.get(requestId);
      if (entry) return entry;
      throw new Error("waiting for structured result");
    });
    expect(structured).toMatchObject({
      request: {
        id: requestId,
        toolName: "bash_command",
        input: { command: "echo hi" },
      },
      result: { type: "tool_result", id: requestId, result: { status: "ok" } },
      structuredResult: {
        toolName: "bash_command",
        exitCode: 0,
        wasAbbreviated: true,
      },
    });
    expect(structured.result.result).not.toHaveProperty("structuredResult");
    for (const message of core.getProviderMessages()) {
      for (const content of message.content) {
        if (content.type === "tool_result") {
          expect(content.result).not.toHaveProperty("structuredResult");
        }
      }
    }
  });
});
describe("Agent bash summary reminder", () => {
  it("fires the bash reminder on the first abbreviated bash output", async () => {
    const { shell } = createMockShell(makeAbbreviatedShellResult());
    const { core, mockClient } = createAgentWithMock({
      shell: shell as unknown as ClientToolContext["shell"],
    });

    void core.submit({
      type: "resolved",
      messages: [
        {
          type: "text",
          text: "run a thing",
        },
      ],
    });
    const stream = await mockClient.awaitStream();
    stream.streamToolUse(
      "tool-bash-1" as ToolRequestId,
      "bash_command" as ToolName,
      { command: "echo hi" },
    );
    stream.finishResponse("tool_use");

    const nextStream = await pollUntil(() => {
      const s = mockClient.streams[mockClient.streams.length - 1];
      if (s && s !== stream) return s;
      throw new Error("waiting for next stream");
    });

    const reminderText = findBashReminderText(nextStream.messages);
    expect(reminderText).toBeDefined();
  });

  it("combines the standing and bash reminders into a single <system-reminder> block when both gates fire", async () => {
    const { shell } = createMockShell(makeAbbreviatedShellResult());
    const { core, mockClient } = createAgentWithMock({
      shell: shell as unknown as ClientToolContext["shell"],
    });

    void core.submit({
      type: "resolved",
      messages: [
        {
          type: "text",
          text: "run a thing",
        },
      ],
    });
    const stream = await mockClient.awaitStream();
    stream.streamToolUse(
      "tool-bash-1" as ToolRequestId,
      "bash_command" as ToolName,
      { command: "echo hi" },
    );
    // High output tokens to also fire the standing reminder gate.
    stream.finishResponse("tool_use", { inputTokens: 1, outputTokens: 5000 });

    const nextStream = await pollUntil(() => {
      const s = mockClient.streams[mockClient.streams.length - 1];
      if (s && s !== stream) return s;
      throw new Error("waiting for next stream");
    });

    const lastUserMsg = nextStream.messages[nextStream.messages.length - 1];
    if (
      lastUserMsg.role !== "user" ||
      typeof lastUserMsg.content === "string"
    ) {
      throw new Error("expected structured user message");
    }

    const reminderBlocks = (
      lastUserMsg.content as Anthropic.ContentBlockParam[]
    ).filter(
      (b): b is Anthropic.TextBlockParam =>
        b.type === "text" && b.text.includes("<system-reminder>"),
    );

    // Exactly one combined system-reminder block should appear
    expect(reminderBlocks.length).toBe(1);
    const combinedText = reminderBlocks[0].text;
    expect((combinedText.match(/<system-reminder>/g) ?? []).length).toBe(1);
    expect((combinedText.match(/<\/system-reminder>/g) ?? []).length).toBe(1);
    // Both bodies are present in the combined block
    expect(combinedText).toContain("Remember the skills");
    expect(combinedText).toContain("bash_summarizer");
  });

  it("fires on every request carrying abbreviated output, and not otherwise", async () => {
    const { shell, setNextResult } = createMockShell(
      makeAbbreviatedShellResult(),
    );
    const { core, mockClient } = createAgentWithMock({
      shell: shell as unknown as ClientToolContext["shell"],
    });

    void core.submit({
      type: "resolved",
      messages: [
        {
          type: "text",
          text: "first",
        },
      ],
    });
    const stream1 = await mockClient.awaitStream();
    stream1.streamToolUse(
      "tool-bash-1" as ToolRequestId,
      "bash_command" as ToolName,
      { command: "echo hi" },
    );
    stream1.finishResponse("tool_use", { inputTokens: 1, outputTokens: 10 });

    const stream2 = await pollUntil(() => {
      const s = mockClient.streams[mockClient.streams.length - 1];
      if (s && s !== stream1) return s;
      throw new Error("waiting for second stream");
    });
    expect(findBashReminderText(stream2.messages)).toBeDefined();

    // A second abbreviated output fires the reminder again: there is no token
    // gate on it, only "did this request carry abbreviated output".
    setNextResult(makeAbbreviatedShellResult());
    stream2.streamToolUse(
      "tool-bash-2" as ToolRequestId,
      "bash_command" as ToolName,
      { command: "echo hi" },
    );
    stream2.finishResponse("tool_use", { inputTokens: 1, outputTokens: 10 });

    const stream3 = await pollUntil(() => {
      const s = mockClient.streams[mockClient.streams.length - 1];
      if (s && s !== stream2) return s;
      throw new Error("waiting for third stream");
    });
    expect(findBashReminderText(stream3.messages)).toBeDefined();

    // A turn whose output was not abbreviated carries no bash reminder.
    setNextResult({
      exitCode: 0,
      signal: undefined,
      output: [{ stream: "stdout" as const, text: "short" }],
      logFilePath: "/tmp/test.log",
      durationMs: 1,
    });
    stream3.streamToolUse(
      "tool-bash-3" as ToolRequestId,
      "bash_command" as ToolName,
      { command: "echo hi" },
    );
    stream3.finishResponse("tool_use", { inputTokens: 1, outputTokens: 10 });

    const stream4 = await pollUntil(() => {
      const s = mockClient.streams[mockClient.streams.length - 1];
      if (s && s !== stream3) return s;
      throw new Error("waiting for fourth stream");
    });
    expect(
      findBashReminderText(stream4.messages.slice(stream3.messages.length)),
    ).toBeUndefined();
  });
});

describe("Agent createFreshAgent thinking effort override", () => {
  it.each([
    { thinking: undefined, effortOverride: undefined, expected: undefined },
    {
      thinking: { enabled: false, effort: "low", budgetTokens: 2048 },
      effortOverride: undefined,
      expected: { enabled: false },
    },
    {
      thinking: {
        enabled: false,
        effort: "low",
        budgetTokens: 2048,
        displayThinking: false,
      },
      effortOverride: "max",
      expected: {
        enabled: true,
        effort: "max",
        budgetTokens: 2048,
        displayThinking: false,
      },
    },
  ] as const)("derives thinking config for $thinking with override $effortOverride", ({
    thinking,
    effortOverride,
    expected,
  }) => {
    const options = anthropicInferenceOptions({
      profile: { model: "claude-sonnet-4-6", thinking } as ProviderProfile,
      systemPrompt: "test",
      tools: [],
      ...(effortOverride ? { effortOverride } : {}),
    });
    expect(options.config).toEqual(
      expected ? { type: "thinking", thinking: expected } : undefined,
    );
  });

  it("applies subagentConfig.effort to thinking when creating agent", () => {
    const captured: InferenceOptions[] = [];
    const spyProvider: Provider = {
      createInferenceManager(
        options: CreateInferenceManagerOptions,
      ): NativeInferenceManager {
        captured.push(anthropicInferenceOptions(options));
        const mockClient = new MockAnthropicClient();
        return new AnthropicInferenceManager(
          anthropicInferenceOptions(options),
          mockClient as unknown as Anthropic,
          defaultAnthropicOptions,
        );
      },
      forceToolUse() {
        throw new Error("Not implemented in mock");
      },
    };

    createAgentWithMock({
      profile: {
        provider: "anthropic",
        model: "claude-3-5-sonnet-20241022",
        thinking: { enabled: true, effort: "low" },
      } as ProviderProfile,
      subagentConfig: { effort: "max" },
      provider: spyProvider,
    });

    expect(captured.length).toBe(1);
    expect(captured[0].config).toEqual({
      type: "thinking",
      thinking: { enabled: true, effort: "max" },
    });
  });

  it("force-enables thinking when profile.thinking is unset but subagent has effort", () => {
    const captured: InferenceOptions[] = [];
    const spyProvider: Provider = {
      createInferenceManager(
        options: CreateInferenceManagerOptions,
      ): NativeInferenceManager {
        captured.push(anthropicInferenceOptions(options));
        const mockClient = new MockAnthropicClient();
        return new AnthropicInferenceManager(
          anthropicInferenceOptions(options),
          mockClient as unknown as Anthropic,
          defaultAnthropicOptions,
        );
      },
      forceToolUse() {
        throw new Error("Not implemented in mock");
      },
    };

    createAgentWithMock({
      profile: {
        provider: "anthropic",
        model: "claude-3-5-sonnet-20241022",
      } as ProviderProfile,
      subagentConfig: { effort: "max" },
      provider: spyProvider,
    });

    expect(captured[0].config).toEqual({
      type: "thinking",
      thinking: { enabled: true, effort: "max" },
    });
  });

  it("uses profile.thinking unchanged when no subagentConfig.effort override", () => {
    const captured: InferenceOptions[] = [];
    const spyProvider: Provider = {
      createInferenceManager(
        options: CreateInferenceManagerOptions,
      ): NativeInferenceManager {
        captured.push(anthropicInferenceOptions(options));
        const mockClient = new MockAnthropicClient();
        return new AnthropicInferenceManager(
          anthropicInferenceOptions(options),
          mockClient as unknown as Anthropic,
          defaultAnthropicOptions,
        );
      },
      forceToolUse() {
        throw new Error("Not implemented in mock");
      },
    };

    createAgentWithMock({
      profile: {
        provider: "anthropic",
        model: "claude-3-5-sonnet-20241022",
        thinking: { enabled: true, effort: "high" },
      } as ProviderProfile,
      provider: spyProvider,
    });

    expect(captured[0].config).toEqual({
      type: "thinking",
      thinking: { enabled: true, effort: "high" },
    });
  });
});

describe("Agent failure", () => {
  /** Drive a send to a provider error and wait for the agent to come to rest. */
  const failSend = async (
    core: Thread,
    mockClient: MockAnthropicClient,
    text: string,
    error = new Error("provider failure"),
  ) => {
    const prev = mockClient.streams[mockClient.streams.length - 1];
    const result = core.submit({
      type: "resolved",
      messages: [
        {
          type: "text",
          text,
        },
      ],
    });
    const stream = await awaitNextStream(mockClient, prev);
    stream.respondWithError(error);
    return await result;
  };

  it("keeps the submitted message in the log, so a retry re-issues it once", async () => {
    const { core, mockClient } = createAgentWithMock();
    const failed = await failSend(core, mockClient, "find the bug");
    expect(failed.type).toBe("failed");
    // Nothing is discarded: the user has nothing to retype.
    expect(core.getProviderMessages()).toHaveLength(1);

    const prev = mockClient.streams[mockClient.streams.length - 1];
    void core.retry();
    const retry = await awaitNextStream(mockClient, prev);
    const userTexts = retry.messages
      .filter((m) => m.role === "user")
      .flatMap((m) => (typeof m.content === "string" ? [] : m.content))
      .filter((c) => c.type === "text")
      .map((c) => c.text);
    expect(userTexts.filter((t) => t.includes("find the bug"))).toHaveLength(1);
  });

  it("keeps earlier completed exchanges alongside the failed submission", async () => {
    const { core, mockClient } = createAgentWithMock();
    void core.submit({
      type: "resolved",
      messages: [
        {
          type: "text",
          text: "first message",
        },
      ],
    });
    const first = await mockClient.awaitStream();
    first.respond({ text: "hi", toolRequests: [], stopReason: "end_turn" });
    await pollUntil(() => {
      if (core.getProviderMessages().length === 2) return true;
      throw new Error("waiting for the first exchange");
    });

    await failSend(core, mockClient, "second message");
    const messages = core.getProviderMessages();
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  });

  it("leaves both queues populated and unresolved, delivering them on the next send", async () => {
    const { core, mockClient } = createAgentWithMock(
      undefined,
      uniqueThreadId("failure-queues"),
    );
    void core.submit({
      type: "resolved",
      messages: [
        {
          type: "text",
          text: "find the bug",
        },
      ],
    });
    const stream = await mockClient.awaitStream();
    core.enqueue(
      {
        type: "resolved",
        messages: [
          {
            type: "text",
            text: "also check the logs",
          },
        ],
      },
      "async",
    );
    core.enqueue(
      {
        type: "resolved",
        messages: [
          {
            type: "text",
            text: "and the config",
          },
        ],
      },
      "next",
    );
    expect(core.queued.async).toHaveLength(1);
    expect(core.queued.next).toHaveLength(1);

    stream.respondWithError(new Error("provider failure"));
    await pollUntil(() => {
      if (core.lastResult()?.type === "failed") return true;
      throw new Error("waiting for error state");
    });
    // The queued entries were never delivered, so they stay queued.
    expect(core.queued.async).toHaveLength(1);
    expect(core.queued.next).toHaveLength(1);

    void core.submit({
      type: "resolved",
      messages: [
        {
          type: "text",
          text: "retry",
        },
      ],
    });
    const retryStream = await awaitNextStream(mockClient, stream);
    retryStream.respond({
      text: "ok",
      toolRequests: [],
      stopReason: "end_turn",
    });
    await pollUntil(() => {
      const texts = core
        .getProviderMessages()
        .flatMap((m) => m.content)
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n");
      if (
        texts.includes("also check the logs") &&
        texts.includes("and the config")
      ) {
        return true;
      }
      throw new Error("waiting for the queues to be delivered");
    });
  });

  it("issues no further requests for a subagent thread after a retryable error", async () => {
    vi.useFakeTimers();
    try {
      const { core, mockClient } = createAgentWithMock({
        threadType: "subagent" as ThreadType,
      });
      void core.submit({
        type: "resolved",
        messages: [
          {
            type: "text",
            text: "flaky task",
          },
        ],
      });
      await vi.advanceTimersByTimeAsync(0);
      const stream = await mockClient.awaitStream();
      // "terminated" is retryable, so exhaust the runner's own retry budget
      // first: what reaches the agent is a runner that has already given up.
      vi.setSystemTime(new Date(Date.now() + 300_001));
      stream.respondWithError(new Error("terminated"));
      await vi.advanceTimersByTimeAsync(0);
      expect(core.lastResult()?.type).toBe("failed");
      // No thread-level retry: advancing past every former backoff delay
      // produces no new request.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(mockClient.streams).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("settles exactly one send result on failure", async () => {
    const { core, mockClient } = createAgentWithMock({
      threadType: "subagent" as ThreadType,
    });
    const settled: SubmissionResult[] = [];
    void core
      .submit({
        type: "resolved",
        messages: [
          {
            type: "text",
            text: "flaky task",
          },
        ],
      })
      .then((r) => settled.push(r as SubmissionResult));
    const stream = await mockClient.awaitStream();
    stream.respondWithError(new Error("provider failure"));
    await pollUntil(() => {
      if (settled.length) return true;
      throw new Error("waiting for the send result");
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(settled).toHaveLength(1);
    expect(settled[0].type).toBe("failed");
  });

  it("leaves no orphan tool_use when the request carrying tool results fails", async () => {
    const fileIO = new InMemoryFileIO({ "/tmp/a.txt": "hello" });
    const { core, mockClient } = createAgentWithMock({ fileIO });
    void core.submit({
      type: "resolved",
      messages: [
        {
          type: "text",
          text: "read it",
        },
      ],
    });
    const stream = await mockClient.awaitStream();
    stream.respond({
      text: "",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: "req-fail" as ToolRequestId,
            toolName: "get_files" as ToolName,
            input: { files: [{ filePath: "/tmp/a.txt" }] },
          },
        },
      ],
      stopReason: "tool_use",
    });
    const second = await awaitNextStream(mockClient, stream);
    second.respondWithError(new Error("provider failure"));
    await pollUntil(() => {
      if (core.lastResult()?.type === "failed") return true;
      throw new Error("waiting for error state");
    });
    // The tool_use stays, but it is answered: what the provider rejects is an
    // unanswered one, not the exchange itself.
    const contents = core.getProviderMessages().flatMap((m) => m.content);
    const toolUseIds = contents
      .filter((c) => c.type === "tool_use")
      .map((c) => c.id);
    const resultIds = contents
      .filter((c) => c.type === "tool_result")
      .map((c) => c.id);
    expect(toolUseIds).toHaveLength(1);
    expect(resultIds).toEqual(toolUseIds);
  });
});
type ParsedEntry = { type: string; [k: string]: unknown };

async function readArchive(threadId: ThreadId): Promise<ParsedEntry[]> {
  const filePath = threadConversationLogPath(threadId, TEST_ARCHIVE_DIR);
  const contents = await fs.readFile(filePath, "utf8");
  return contents
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as ParsedEntry);
}

describe("Agent conversation archive", () => {
  it("writes a normal turn's full messages (tool_use + tool_result) to the archive", async () => {
    const threadId = uniqueThreadId("archive-normal");
    const fileIO = new InMemoryFileIO({ "/tmp/a.txt": "hello" });
    const { core, mockClient } = createAgentWithMock({ fileIO }, threadId);

    try {
      void core.submit({
        type: "resolved",
        messages: [
          {
            type: "text",
            text: "edit a",
          },
        ],
      });
      const stream = await mockClient.awaitStream();
      stream.streamToolUse("edl-1" as ToolRequestId, "edl" as ToolName, {
        script: `file \`/tmp/a.txt\`\nnarrow /hello/\nreplace "bye"`,
      });
      stream.finishResponse("tool_use");

      const nextStream = await pollUntil(() => {
        if (mockClient.streams.length < 2) throw new Error("waiting");
        return mockClient.streams[1];
      });
      nextStream.streamText("done");
      nextStream.finishResponse("end_turn");

      await pollUntil(() => {
        if (flatLoop(core).type !== "idle") throw new Error("waiting");
        return true;
      });
      await flushArchive(core);

      const entries = await readArchive(threadId);
      expect(entries[0].type).toBe("thread_start");

      const messages = entries.filter((e) => e.type === "message");
      const serialized = JSON.stringify(messages);
      expect(serialized).toContain('"type":"tool_use"');
      expect(serialized).toContain('"type":"tool_result"');
      expect(serialized).toContain("/tmp/a.txt");
    } finally {
      await core.destroy();
      await flushArchive(core);
      await cleanupArchive(threadId);
    }
  });

  it("persists completed messages mid-turn but withholds the streaming one", async () => {
    const threadId = uniqueThreadId("archive-withhold");
    const fileIO = new InMemoryFileIO({ "/tmp/a.txt": "hello" });
    const { core, mockClient } = createAgentWithMock({ fileIO }, threadId);

    try {
      void core.submit({
        type: "resolved",
        messages: [
          {
            type: "text",
            text: "edit a",
          },
        ],
      });
      const stream = await mockClient.awaitStream();
      stream.streamToolUse("edl-1" as ToolRequestId, "edl" as ToolName, {
        script: `file \`/tmp/a.txt\`\nnarrow /hello/\nreplace "bye"`,
      });
      stream.finishResponse("tool_use");

      // Second stream begins once the earlier turn steps are finalized. The
      // assistant's in-flight text is not yet a finalized message, so onUpdate
      // persists the completed tool_use but withholds the streaming reply.
      const nextStream = await pollUntil(() => {
        if (mockClient.streams.length < 2) throw new Error("waiting");
        return mockClient.streams[1];
      });
      nextStream.streamText("streaming-reply");
      await flushArchive(core);

      const midSerialized = JSON.stringify(
        (await readArchive(threadId)).filter((e) => e.type === "message"),
      );
      expect(midSerialized).toContain('"type":"tool_use"');
      expect(midSerialized).not.toContain("streaming-reply");

      nextStream.finishResponse("end_turn");
      await pollUntil(() => {
        if (flatLoop(core).type !== "idle") throw new Error("waiting");
        return true;
      });
      await flushArchive(core);

      const finalSerialized = JSON.stringify(
        (await readArchive(threadId)).filter((e) => e.type === "message"),
      );
      expect(finalSerialized).toContain('"type":"tool_result"');
      expect(finalSerialized).toContain("streaming-reply");
    } finally {
      await core.destroy();
      await flushArchive(core);
      await cleanupArchive(threadId);
    }
  });

  it("inserts a compaction marker between agent generations and keeps appending", async () => {
    const threadId = uniqueThreadId("archive-compact");
    const { core, mockClient } = createAgentWithMock(
      {
        resolve: async () =>
          compactResolved([
            {
              type: "text",
              text: "",
            },
          ]),
      },
      threadId,
    );

    try {
      void core.submit({
        type: "resolved",
        messages: [
          {
            type: "text",
            text: "first turn",
          },
        ],
      });
      const stream = await mockClient.awaitStream();
      stream.streamText("done");
      stream.finishResponse("end_turn");

      await pollUntil(() => {
        if (flatLoop(core).type !== "idle") throw new Error("waiting");
        return true;
      });
      await flushArchive(core);

      compactorSlot(core).compactor = {
        run: (_messages, next) =>
          Promise.resolve({
            type: "complete",
            summary: { text: "SUMMARY TEXT", chunkCount: 2 },
            next: [...next],
          }),
      };

      const compactPromise = core.submit({
        type: "raw",
        message: pendingMessage("@compact"),
      });

      const contStream = await pollUntil(() => {
        if (mockClient.streams.length < 2) throw new Error("waiting");
        return mockClient.streams[1];
      });
      contStream.streamText("resumed");
      contStream.finishResponse("end_turn");
      await compactPromise;
      await pollUntil(() => {
        if (flatLoop(core).type !== "idle") throw new Error("waiting");
        return true;
      });
      await flushArchive(core);

      const entries = await readArchive(threadId);
      const types = entries.map((e) => e.type);
      const compactionIdx = types.indexOf("compaction");
      expect(compactionIdx).toBeGreaterThan(0);
      expect(types.indexOf("message")).toBeLessThan(compactionIdx);
      expect(types.lastIndexOf("message")).toBeGreaterThan(compactionIdx);

      const compaction = entries[compactionIdx];
      expect(compaction.summary).toBe("SUMMARY TEXT");
      expect(compaction.chunkCount).toBe(2);
    } finally {
      await core.destroy();
      await flushArchive(core);
      await cleanupArchive(threadId);
    }
  });

  it("writes a self-contained, fork-marked archive for a cloned thread", async () => {
    const parentId = uniqueThreadId("archive-parent");
    const childId = uniqueThreadId("archive-child");
    const {
      core: parent,
      mockClient,
      context,
    } = createAgentWithMock(undefined, parentId);

    let child: Thread | undefined;
    try {
      void parent.submit({
        type: "resolved",
        messages: [
          {
            type: "text",
            text: "parent turn",
          },
        ],
      });
      const stream = await mockClient.awaitStream();
      stream.streamText("parent response");
      stream.finishResponse("end_turn");

      await pollUntil(() => {
        if (flatLoop(parent).type !== "idle") throw new Error("waiting");
        return true;
      });

      const nativeMessageIdx = parent["core"].manager.getNativeMessageIdx();
      child = await cloneThread({
        sourceThread: parent,
        newId: childId,
        nativeMessageIdx,
        context: context,
        callbacks: { onUpdate: () => {} },
      });

      void child.submit({
        type: "resolved",
        messages: [
          {
            type: "text",
            text: "child turn",
          },
        ],
      });
      const childStream = await pollUntil(() => {
        const s = mockClient.streams[mockClient.streams.length - 1];
        if (!s || s === stream) throw new Error("waiting");
        return s;
      });
      childStream.streamText("child response");
      childStream.finishResponse("end_turn");

      await pollUntil(() => {
        if (flatLoop(child!).type !== "idle") throw new Error("waiting");
        return true;
      });
      await flushArchive(child);
      await flushArchive(parent);

      const childEntries = await readArchive(childId);
      expect(childEntries[0].type).toBe("thread_start");
      expect(childEntries[1].type).toBe("fork");
      expect(childEntries[1].fromThreadId).toBe(parentId);
      expect(childEntries[1].nativeMessageIdx).toBe(nativeMessageIdx);

      const childMessages = childEntries.filter((e) => e.type === "message");
      const childSerialized = JSON.stringify(childMessages);
      expect(childSerialized).toContain("parent turn");
      expect(childSerialized).toContain("child turn");

      const parentEntries = await readArchive(parentId);
      expect(parentEntries.some((e) => e.type === "fork")).toBe(false);
    } finally {
      await parent.destroy();
      if (child) await child.destroy();
      await cleanupArchive(parentId);
      await cleanupArchive(childId);
    }
  });
});

describe("Agent thread state", () => {
  it("clone deep-copies edlRegisters with isolation", async () => {
    const parentId = uniqueThreadId("sp-parent");
    const childId = uniqueThreadId("sp-child");
    const {
      core: parent,
      mockClient,
      context,
    } = createAgentWithMock(undefined, parentId);
    let child: Thread | undefined;
    try {
      void parent.submit({
        type: "resolved",
        messages: [
          {
            type: "text",
            text: "parent turn",
          },
        ],
      });
      const stream = await mockClient.awaitStream();
      stream.streamText("parent response");
      stream.finishResponse("end_turn");
      await pollUntil(() => {
        if (flatLoop(parent).type !== "idle") throw new Error("waiting");
        return true;
      });

      parent["core"].edlRegisters.registers.set("r", "regval");
      parent["core"].edlRegisters.nextSavedId = 3;

      const nativeMessageIdx = parent["core"].manager.getNativeMessageIdx();
      child = await cloneThread({
        sourceThread: parent,
        newId: childId,
        nativeMessageIdx,
        context: context,
        callbacks: { onUpdate: () => {} },
      });

      expect(child["core"].edlRegisters.registers.get("r")).toBe("regval");
      expect(child["core"].edlRegisters.nextSavedId).toBe(3);

      child["core"].edlRegisters.registers.set("r2", "x");
      expect(parent["core"].edlRegisters.registers.has("r2")).toBe(false);
    } finally {
      await parent.destroy();
      if (child) await child.destroy();
      await cleanupArchive(parentId);
      await cleanupArchive(childId);
    }
  });
});

describe("Thread survives the compaction agent swap", () => {
  const compactResolver = async () =>
    compactResolved([
      {
        type: "text" as const,
        text: "",
      },
    ]);
  /** Drive a compaction handoff to completion, including the post-compaction
   * continuation turn the fresh agent issues. */
  async function compact(
    core: Thread,
    mockClient: MockAnthropicClient,
  ): Promise<void> {
    const streamsBefore = mockClient.streams.length;
    compactorSlot(core).compactor = {
      run: (_messages, next) =>
        Promise.resolve({
          type: "complete",
          summary: { text: "SUMMARY TEXT", chunkCount: 1 },
          next: [...next],
        }),
    };

    const compactPromise = core.submit({
      type: "raw",
      message: pendingMessage("@compact"),
    });
    const contStream = await pollUntil(() => {
      if (mockClient.streams.length <= streamsBefore)
        throw new Error("waiting");
      return mockClient.streams[streamsBefore];
    });
    contStream.streamText("resumed");
    contStream.finishResponse("end_turn");
    await compactPromise;
    await pollUntil(() => {
      if (flatLoop(core).type !== "idle") throw new Error("waiting");
      return true;
    });
  }

  it("keeps structured tool results recorded before the compaction", async () => {
    const threadId = uniqueThreadId("compact-structured");
    const { core, mockClient } = createAgentWithMock(
      { resolve: compactResolver },
      threadId,
    );
    try {
      const map = core.completedTools as Map<ToolRequestId, CompletedToolInfo>;
      map.set("req-1" as ToolRequestId, {
        request: {
          id: "req-1" as ToolRequestId,
          toolName: "thread_title" as ToolName,
          input: { title: "Before compaction" },
        },
        result: {
          type: "tool_result",
          id: "req-1" as ToolRequestId,
          result: { status: "ok", value: [] },
        },
        structuredResult: { toolName: "thread_title" },
      });
      await compact(core, mockClient);
      // Compaction replaces the conversation, not the thread-owned archive.
      expect(core.completedTools).toBe(map);
      expect(core.completedTools.has("req-1" as ToolRequestId)).toBe(true);
    } finally {
      await core.destroy();
      await flushArchive(core);
      await cleanupArchive(threadId);
    }
  });

  it("forwards events from the replacement agent and none from the old one", async () => {
    const threadId = uniqueThreadId("compact-events");
    let updates = 0;
    const { core, mockClient } = createAgentWithMock(
      { resolve: compactResolver },
      threadId,
      undefined,
      () => updates++,
    );
    try {
      const oldAgent = core["core"].manager;
      await compact(core, mockClient);
      expect(core["core"].manager).not.toBe(oldAgent);

      updates = 0;
      core.setTitle("after compaction");
      expect(updates).toBe(1);
    } finally {
      await core.destroy();
      await flushArchive(core);
      await cleanupArchive(threadId);
    }
  });

  it("opens the replacement agent with the summary and nothing older", async () => {
    const threadId = uniqueThreadId("compact-prefix");
    const { core, mockClient } = createAgentWithMock(
      {
        resolve: async () =>
          compactResolved([
            {
              type: "text",
              text: "",
            },
          ]),
      },
      threadId,
    );
    try {
      compactorSlot(core).compactor = {
        run: (_messages, next) =>
          Promise.resolve({
            type: "complete",
            summary: { text: "SUMMARY TEXT", chunkCount: 1 },
            next: [...next],
          }),
      };

      const compactPromise = core.submit({
        type: "raw",
        message: pendingMessage("@compact"),
      });
      const contStream = await mockClient.awaitStream();
      const body = JSON.stringify(contStream.messages);
      expect(body).toContain("SUMMARY TEXT");
      expect(body).not.toContain("the old conversation");
      contStream.streamText("resumed");
      contStream.finishResponse("end_turn");
      await compactPromise;
      await pollUntil(() => {
        if (flatLoop(core).type !== "idle") throw new Error("waiting");
        return true;
      });
    } finally {
      await core.destroy();
      await flushArchive(core);
      await cleanupArchive(threadId);
    }
  });

  it("still opens with the summary when the continuation is preempted", async () => {
    const threadId = uniqueThreadId("compact-preempt");
    const { core, mockClient } = createAgentWithMock(
      { resolve: compactResolver },
      threadId,
    );
    try {
      compactorSlot(core).compactor = {
        run: (_messages, next) =>
          Promise.resolve({
            type: "complete",
            summary: { text: "SUMMARY TEXT", chunkCount: 1 },
            next: [...next],
          }),
      };
      const compactPromise = core.submit({
        type: "raw",
        message: pendingMessage("@compact"),
      });
      const contStream = await mockClient.awaitStream();
      // The continuation never gets to finish: a new send takes the thread
      // over, and it is that turn which must carry the summary.
      const preempt = core.submit({
        type: "resolved",
        messages: [
          {
            type: "text",
            text: "new direction",
          },
        ],
      });
      void contStream;
      await compactPromise;
      const preemptStream = await pollUntil(() => {
        const stream = mockClient.streams.at(-1);
        if (!stream || stream === contStream) throw new Error("waiting");
        return stream;
      });
      const body = JSON.stringify(preemptStream.messages);
      expect(body).toContain("SUMMARY TEXT");
      expect(body).toContain("new direction");
      preemptStream.streamText("ok");
      preemptStream.finishResponse("end_turn");
      await preempt;
    } finally {
      await core.destroy();
      await flushArchive(core);
      await cleanupArchive(threadId);
    }
  });
});
describe("Thread preflight token count", () => {
  it("clears the count when it fails rather than reporting a stale one", async () => {
    const { core: agent, mockClient } = createAgentWithMock(
      autoCompactSupervisors({ threshold: 1000, handoff: "go" }),
    );

    mockClient.mockInputTokenCount = 42;
    const first = agent.submit({
      type: "resolved",
      messages: [
        {
          type: "text",
          text: "hello",
        },
      ],
    });
    const stream = await mockClient.awaitStream();
    stream.streamText("ok");
    stream.finishResponse("end_turn");
    await first;
    expect(agent.inputTokenCount).toBe(42);

    mockClient.countTokensError = new Error("count failed");
    const second = agent.submit({
      type: "resolved",
      messages: [
        {
          type: "text",
          text: "again",
        },
      ],
    });
    const stream2 = await pollUntil(() => {
      const s = mockClient.streams[1];
      if (!s) throw new Error("waiting for the second request");
      return s;
    });
    stream2.streamText("ok");
    stream2.finishResponse("end_turn");
    await second;
    expect(agent.inputTokenCount).toBeUndefined();
  });
});
describe("Agent turn loop", () => {
  it("an abort mid-stream unwinds once, leaving one abort marker", async () => {
    const { agent, mockClient } = createTestAgent();
    const { promise: turn } = agent.send([
      {
        type: "text",
        text: "hello",
      },
    ]);
    const stream = await mockClient.awaitStream();
    stream.streamText("partial");

    void agent.abortAndWait();
    void agent.abortAndWait();
    expect(await turn).toEqual({ type: "aborted" });

    const texts = agent
      .getProviderMessages()
      .flatMap((m) => m.content)
      .filter((c) => c.type === "text")
      .map((c) => (c as { text: string }).text);
    expect(
      texts.filter((text) => text.includes("aborted the previous")),
    ).toHaveLength(1);
    expect(flatLoop(agent)).toEqual({ type: "idle" });
  });

  it("the streaming block on the phase is a copy, not the manager's own", async () => {
    const { agent, mockClient } = createTestAgent();
    const { promise: turn } = agent.send([
      {
        type: "text",
        text: "hello",
      },
    ]);
    const stream = await mockClient.awaitStream();

    stream.emitEvent({
      type: "content_block_start",
      index: stream.nextBlockIndex(),
      content_block: { type: "text", text: "", citations: null },
    });
    await stream.settle();
    const phase = flatLoop(agent);
    if (phase.type !== "streaming") throw new Error("expected streaming");
    const first = phase.block;

    stream.emitEvent({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "more" },
    });
    await stream.settle();

    // The block the view already read must not have changed under it.
    expect(first).toEqual({ type: "text", text: "" });
    const later = flatLoop(agent);
    expect(later.type === "streaming" && later.block).not.toBe(first);

    void agent.abortAndWait();
    await turn;
  });

  it("notifies with the abort marker already in the log", async () => {
    const snapshots: string[][] = [];
    const { agent, mockClient } = createTestAgent({
      onUpdate: () => {
        snapshots.push(
          agent
            .getProviderMessages()
            .flatMap((m) => m.content)
            .filter((c) => c.type === "text")
            .map((c) => (c as { text: string }).text),
        );
      },
    });
    const { promise: turn } = agent.send([
      {
        type: "text",
        text: "hello",
      },
    ]);
    const stream = await mockClient.awaitStream();
    stream.emitEvent({
      type: "content_block_start",
      index: stream.nextBlockIndex(),
      content_block: { type: "text", text: "partial", citations: null },
    });
    await stream.settle();
    await agent.abortAndWait();
    expect(await turn).toEqual({ type: "aborted" });
    // The view must refresh once the marker is in the log, rather than
    // waiting for some unrelated later event.
    expect(snapshots.some((texts) => texts.includes(ABORT_MARKER_TEXT))).toBe(
      true,
    );
  });

  it("injections from the gate ride the caller's own user message", async () => {
    const { agent, mockClient } = createTestAgent({
      onBeforeRequest: () =>
        Promise.resolve([
          {
            type: "text",
            text: "injected",
          },
        ]),
    });
    const { promise: turn } = agent.send([
      {
        type: "text",
        text: "hello",
      },
    ]);
    const stream = await mockClient.awaitStream();

    const messages = agent.getProviderMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("user");
    expect(
      messages[0].content
        .filter((c) => c.type === "text")
        .map((c) => (c as { text: string }).text),
    ).toEqual(["injected", "hello"]);

    stream.finishResponse("end_turn");
    await turn;
  });

  it("a rejecting executor still answers every tool_use", async () => {
    const { agent, mockClient } = createTestAgent({
      executeTools: () =>
        Promise.resolve(Promise.reject(new Error("executor blew up"))),
    });
    const { promise: turn } = agent.send([
      {
        type: "text",
        text: "hello",
      },
    ]);
    const stream = await mockClient.awaitStream();
    stream.streamToolUse("tool-1" as ToolRequestId, "get_files" as ToolName, {
      files: [{ filePath: "/tmp/a.txt" }],
    });
    stream.finishResponse("tool_use");

    const second = await pollUntil(() => {
      const s = mockClient.streams[1];
      if (!s) throw new Error("waiting for the continuation");
      return s;
    });
    const results = agent
      .getProviderMessages()
      .flatMap((m) => m.content)
      .filter((c) => c.type === "tool_result");
    expect(results).toHaveLength(1);

    second.finishResponse("end_turn");
    expect(await turn).toEqual({ type: "completed", stopReason: "end_turn" });
  });

  it("an executor that reports it aborted unwinds the turn once", async () => {
    const { agent, mockClient } = createTestAgent({
      executeTools: () =>
        Promise.resolve(
          Promise.resolve({ type: "aborted" as const, results: new Map() }),
        ),
    });
    const { promise: turn } = agent.send([
      {
        type: "text",
        text: "hello",
      },
    ]);
    const stream = await mockClient.awaitStream();
    stream.streamToolUse("tool-1" as ToolRequestId, "get_files" as ToolName, {
      files: [{ filePath: "/tmp/a.txt" }],
    });
    stream.finishResponse("tool_use");

    expect(await turn).toEqual({ type: "aborted" });
    const texts = agent
      .getProviderMessages()
      .flatMap((m) => m.content)
      .filter((c) => c.type === "text")
      .map((c) => (c as { text: string }).text);
    expect(
      texts.filter((text) => text.includes("aborted the previous")),
    ).toHaveLength(1);
    expect(mockClient.streams).toHaveLength(1);
  });

  it("clears the live invocations before the results land in the log", async () => {
    const snapshots: { hasActive: boolean; results: number }[] = [];
    const { agent, mockClient } = createTestAgent({
      onUpdate: () => {
        snapshots.push({
          hasActive: activeTools(agent.state) !== undefined,
          results: agent
            .getProviderMessages()
            .flatMap((m) => m.content)
            .filter((c) => c.type === "tool_result").length,
        });
      },
    });
    const { promise: turn } = agent.send([
      {
        type: "text",
        text: "hello",
      },
    ]);
    const stream = await mockClient.awaitStream();
    stream.streamToolUse("tool-1" as ToolRequestId, "get_files" as ToolName, {
      files: [{ filePath: "/tmp/a.txt" }],
    });
    stream.finishResponse("tool_use");
    const second = await awaitNextStream(mockClient, stream);
    second.finishResponse("end_turn");
    await turn;
    // The view switches from tool progress to results the moment the map
    // empties, so no frame may show both.
    expect(snapshots.filter((s) => s.hasActive && s.results > 0)).toHaveLength(
      0,
    );
    expect(snapshots.some((s) => s.hasActive)).toBe(true);
  });

  // The thread owns aborting the tools now (see thread.test.ts "Thread aborts
  // the tools it owns"); what this pins is the agent side: a turn whose tools
  // were aborted underneath it still settles as `aborted`.
  it("settles as aborted when the tools are aborted while they run", async () => {
    let resolveStat!: () => void;
    const statPromise = new Promise<{ mtimeMs: number; size: number }>(
      (resolve) => {
        resolveStat = () => resolve({ mtimeMs: 0, size: 100 });
      },
    );
    const { agent, mockClient } = createTestAgent({
      context: {
        fileIO: {
          readFile: async () => "file contents",
          writeFile: async () => {},
          fileExists: async () => true,
          stat: async () => statPromise,
        } as unknown as ThreadContext["fileIO"],
      },
    });
    const { promise: turn } = agent.send([
      {
        type: "text",
        text: "hello",
      },
    ]);
    const stream = await mockClient.awaitStream();
    stream.streamToolUse("tool-1" as ToolRequestId, "get_files" as ToolName, {
      files: [{ filePath: "/tmp/a.txt" }],
    });
    stream.finishResponse("tool_use");
    const active = await pollUntil(() => {
      const tools = activeTools(agent.state);
      if (!tools?.size) throw new Error("waiting for live invocations");
      return tools;
    });
    const abortSpies = [...active.values()].map((entry) =>
      vi.spyOn(entry.handle, "abort"),
    );
    const abortPromise = agent.abortAndWait();
    resolveStat();
    await abortPromise;
    for (const spy of abortSpies) expect(spy).toHaveBeenCalled();
    expect(await turn).toEqual({ type: "aborted" });
  });

  it("a failed request finalizes the log and fails the turn", async () => {
    const { agent, mockClient } = createTestAgent();
    const turn = agent.send([
      {
        type: "text",
        text: "hello",
      },
    ]);
    const stream = await mockClient.awaitStream();
    stream.streamText("half an answer");
    await stream.settle();
    stream.respondWithError(new Error("connection lost"));

    const result = await turn.promise;
    expect(result.type).toBe("failed");
    // Finalized: the half-streamed assistant turn is left in a shape the
    // provider will accept on the next request.
    expect(flatLoop(agent)).toEqual({ type: "idle" });
    expect(mockClient.streams).toHaveLength(1);
  });
});

describe("nativeMessageIdx plumbing", () => {
  /** Where the block carrying `text` actually landed, as the wire recorded it. */
  const idxOfText = (
    core: { getProviderMessages(): ReadonlyArray<ProviderMessage> },
    text: string,
  ): NativeMessageIdx | undefined => {
    for (const message of core.getProviderMessages()) {
      for (const block of message.content) {
        if (block.type === "text" && block.text.includes(text)) {
          return block.nativeMessageIdx;
        }
      }
    }
    return undefined;
  };

  it("onBeforeRequest reports the idx its injection lands at, on the opening request", async () => {
    const { core, mockClient } = createAgentWithMock({
      toolLoopSupervisors: [
        {
          onBeforeRequest: (ctx) => {
            seen.push(ctx.nativeMessageIdx);
            return Promise.resolve(injectText("INJECTED-OPENING"));
          },
        },
      ],
    });
    const seen: NativeMessageIdx[] = [];

    void core.submit({
      type: "resolved",
      messages: [
        {
          type: "text",
          text: "hello",
        },
      ],
    });
    const stream = await mockClient.awaitStream();
    stream.streamText("ok");
    stream.finishResponse("end_turn");
    await pollUntil(() => {
      if (idxOfText(core, "INJECTED-OPENING") !== undefined) return true;
      throw new Error("waiting for the injection to land");
    });
    expect(seen).toEqual([0]);
    expect(idxOfText(core, "INJECTED-OPENING")).toBe(seen[0]);
    // The caller's own input merges into the same user message.
    expect(idxOfText(core, "hello")).toBe(seen[0]);
  });

  it("onBeforeRequest reports the tool-result message on a continuation, because the injection merges into it", async () => {
    const fileIO = new InMemoryFileIO({ "/tmp/b.txt": "other" });
    const { core, mockClient } = createAgentWithMock({
      toolLoopSupervisors: [
        {
          onBeforeRequest: (ctx) => {
            requestIdx.push(ctx.nativeMessageIdx);
            return Promise.resolve(
              injectText(`INJECTED-${requestIdx.length - 1}`),
            );
          },
          onToolResults: (_results, nativeMessageIdx) => {
            resultIdx.push(nativeMessageIdx);
          },
        },
      ],
      fileIO: fileIO as unknown as ThreadContext["fileIO"],
    });
    const requestIdx: NativeMessageIdx[] = [];
    const resultIdx: NativeMessageIdx[] = [];

    void core.submit({
      type: "resolved",
      messages: [
        {
          type: "text",
          text: "hello",
        },
      ],
    });
    const stream = await mockClient.awaitStream();
    stream.streamToolUse("get-1" as ToolRequestId, "get_files" as ToolName, {
      files: [{ filePath: "/tmp/b.txt" }],
    });
    stream.finishResponse("tool_use");
    const stream2 = await awaitNextStream(mockClient, stream);
    stream2.streamText("done");
    stream2.finishResponse("end_turn");
    await pollUntil(() => {
      if (idxOfText(core, "INJECTED-1") !== undefined) return true;
      throw new Error("waiting for the continuation injection to land");
    });
    expect(idxOfText(core, "INJECTED-0")).toBe(requestIdx[0]);
    expect(idxOfText(core, "INJECTED-1")).toBe(requestIdx[1]);
    // `appendUserMessage` merges into the trailing tool-result user message,
    // so the continuation's injection lands *on* it rather than after it.
    expect(requestIdx[1]).toBe(resultIdx[0]);
  });

  it("onToolResults and onToolApplied report the idx of the message that holds the tool result", async () => {
    const fileIO = new InMemoryFileIO({ "/tmp/b.txt": "other" });
    const { core, mockClient } = createAgentWithMock({
      toolLoopSupervisors: [
        {
          onToolApplied: ({ nativeMessageIdx }) => {
            appliedIdx.push(nativeMessageIdx);
          },
          onToolResults: (_results, nativeMessageIdx) => {
            resultIdx.push(nativeMessageIdx);
          },
        },
      ],
      fileIO: fileIO as unknown as ThreadContext["fileIO"],
    });
    const appliedIdx: NativeMessageIdx[] = [];
    const resultIdx: NativeMessageIdx[] = [];

    void core.submit({
      type: "resolved",
      messages: [
        {
          type: "text",
          text: "hello",
        },
      ],
    });
    const stream = await mockClient.awaitStream();
    stream.streamToolUse("get-1" as ToolRequestId, "get_files" as ToolName, {
      files: [{ filePath: "/tmp/b.txt" }],
    });
    stream.finishResponse("tool_use");
    const stream2 = await awaitNextStream(mockClient, stream);
    stream2.streamText("done");
    stream2.finishResponse("end_turn");
    await pollUntil(() => {
      if (resultIdx.length === 1) return true;
      throw new Error("waiting for tool results");
    });
    expect(appliedIdx).toEqual(resultIdx);
    const landed = core
      .getProviderMessages()
      .flatMap((message) => message.content)
      .find(
        (block) =>
          block.type === "tool_result" &&
          block.id === ("get-1" as ToolRequestId),
      );
    expect(landed?.nativeMessageIdx).toBe(resultIdx[0]);
  });

  it("reports the end of a parallel batch, which spans one message per result", async () => {
    const fileIO = new InMemoryFileIO({
      "/tmp/b.txt": "other",
      "/tmp/c.txt": "more",
    });
    const { core, mockClient } = createAgentWithMock({
      toolLoopSupervisors: [
        {
          onToolApplied: ({ nativeMessageIdx }) => {
            appliedIdx.push(nativeMessageIdx);
          },
          onToolResults: (_results, nativeMessageIdx) => {
            resultIdx.push(nativeMessageIdx);
          },
        },
      ],
      fileIO: fileIO as unknown as ThreadContext["fileIO"],
    });
    const appliedIdx: NativeMessageIdx[] = [];
    const resultIdx: NativeMessageIdx[] = [];

    void core.submit({
      type: "resolved",
      messages: [
        {
          type: "text",
          text: "hello",
        },
      ],
    });
    const stream = await mockClient.awaitStream();
    stream.streamToolUse("get-1" as ToolRequestId, "get_files" as ToolName, {
      files: [{ filePath: "/tmp/b.txt" }],
    });
    stream.streamToolUse("get-2" as ToolRequestId, "get_files" as ToolName, {
      files: [{ filePath: "/tmp/c.txt" }],
    });
    stream.finishResponse("tool_use");
    await pollUntil(() => {
      if (resultIdx.length === 1) return true;
      throw new Error("waiting for tool results");
    });
    const landed = core
      .getProviderMessages()
      .flatMap((message) => message.content)
      .filter((block) => block.type === "tool_result")
      .map((block) => block.nativeMessageIdx);
    expect(landed).toHaveLength(2);
    // One user message per result: the reported idx is the last of them, so
    // truncating inside the batch drops whatever a supervisor keyed on it.
    expect(Math.max(...landed)).toBe(resultIdx[0]);
    expect(new Set(appliedIdx)).toEqual(new Set([resultIdx[0]]));
  });
});

describe("tool loop recognises yield", () => {
  const yieldOnce = (
    result: { status: "ok"; value: [] } | { status: "error"; error: string },
    type: "continue" | "aborted" = "continue",
  ) =>
    createTestAgent({
      context: { threadType: "subagent" as ThreadType },
      executeTools: (requests) =>
        Promise.resolve(
          Promise.resolve({
            type,
            results: new Map(requests.map(({ id }) => [id, result])),
          }),
        ),
    });

  it("ends the loop with the yield value once its result is logged", async () => {
    const { agent, mockClient } = yieldOnce({ status: "ok", value: [] });
    const { promise: turn } = agent.send([{ type: "text", text: "go" }]);
    const stream = await mockClient.awaitStream();
    stream.streamToolUse(
      "y-1" as ToolRequestId,
      "yield_to_parent" as ToolName,
      {
        result: "done",
      },
    );
    stream.finishResponse("tool_use");
    expect(await turn).toEqual({ type: "yield", value: { result: "done" } });
    expect(agent.getProviderMessages().at(-1)).toMatchObject({
      content: [{ type: "tool_result", id: "y-1" }],
    });
    expect(mockClient.streams.length).toBe(1);
  });

  it("continues when the yield tool's result is an error", async () => {
    const { agent, mockClient } = yieldOnce({ status: "error", error: "nope" });
    const { promise: turn } = agent.send([{ type: "text", text: "go" }]);
    const stream = await mockClient.awaitStream();
    stream.streamToolUse(
      "y-1" as ToolRequestId,
      "yield_to_parent" as ToolName,
      {
        result: "done",
      },
    );
    stream.finishResponse("tool_use");
    const next = await awaitNextStream(mockClient, stream);
    expect(agent.getProviderMessages().at(-1)).toMatchObject({
      content: [{ id: "y-1", result: { status: "error", error: "nope" } }],
    });
    next.finishResponse("end_turn");
    expect(await turn).toEqual({ type: "completed", stopReason: "end_turn" });
  });

  it("yields from a mixed batch after every result is logged", async () => {
    const { agent, mockClient } = yieldOnce({ status: "ok", value: [] });
    const { promise: turn } = agent.send([{ type: "text", text: "go" }]);
    const stream = await mockClient.awaitStream();
    stream.streamToolUse("o-1" as ToolRequestId, "get_file" as ToolName, {
      filePath: "a.ts",
    });
    stream.streamToolUse(
      "y-1" as ToolRequestId,
      "yield_to_parent" as ToolName,
      { result: "done" },
    );
    stream.finishResponse("tool_use");
    expect(await turn).toEqual({ type: "yield", value: { result: "done" } });
    expect(agent.getProviderMessages().slice(-2)).toMatchObject([
      { content: [{ type: "tool_result", id: "o-1" }] },
      { content: [{ type: "tool_result", id: "y-1" }] },
    ]);
    expect(mockClient.streams.length).toBe(1);
  });
  it("reports an abort, not a yield, when the batch was aborted", async () => {
    const { agent, mockClient } = yieldOnce(
      { status: "ok", value: [] },
      "aborted",
    );
    const { promise: turn } = agent.send([{ type: "text", text: "go" }]);
    const stream = await mockClient.awaitStream();
    stream.streamToolUse(
      "y-1" as ToolRequestId,
      "yield_to_parent" as ToolName,
      {
        result: "done",
      },
    );
    stream.finishResponse("tool_use");
    expect(await turn).toEqual({ type: "aborted" });
  });
});

function nextText(next: ReadonlyArray<AgentInput>): string | undefined {
  return (
    next.flatMap((i) => (i.type === "text" ? [i.text] : [])).join("\n\n") ||
    undefined
  );
}
