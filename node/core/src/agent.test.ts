import * as fs from "node:fs/promises";
import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import type { ActiveToolEntry, AgentContext } from "./agent.ts";
import type { ToolApplied } from "./capabilities/context-tracker.ts";
import type { OutputLine, Shell, ShellResult } from "./capabilities/shell.ts";
import type { ThreadId, ThreadType } from "./chat-types.ts";
import {
  type CompactionOutcome,
  type Compactor,
  runSubmission,
} from "./compaction/index.ts";
import { InMemoryFileIO } from "./edl/in-memory-file-io.ts";
import type { ProviderProfile } from "./provider-options.ts";
import { AnthropicRunner } from "./providers/anthropic-runner.ts";
import { MockAnthropicClient } from "./providers/mock-anthropic-client.ts";
import type {
  AgentOptions,
  Provider,
  Runner,
} from "./providers/provider-types.ts";
import { PLACEHOLDER_NATIVE_MESSAGE_IDX } from "./providers/provider-types.ts";
import {
  pendingMessage,
  renderPending,
  resolveAsText,
} from "./submission/index.ts";
import {
  awaitNextStream,
  cleanupArchive,
  createAgentWithMock,
  defaultAnthropicOptions,
  TEST_ARCHIVE_DIR,
  uniqueThreadId,
} from "./test-helpers.ts";
import { Thread } from "./thread.ts";
import type { SendResult, ThreadSendResult } from "./thread-api.ts";
import {
  AutoCompactSupervisor,
  composeSupervisors,
  injectText,
  MaxTokensSupervisor,
  SubagentSupervisor,
  type ThreadSupervisor,
  UnsupervisedSupervisor,
} from "./thread-supervisor.ts";
import type { ToolName, ToolRequestId } from "./tool-types.ts";
import { pollUntil } from "./utils/async.ts";
import type { AbsFilePath } from "./utils/files.ts";
import { threadConversationLogPath } from "./utils/files.ts";

describe("Thread.phase", () => {
  it("is idle with no result before anything is sent", () => {
    const { core } = createAgentWithMock();
    expect(core.phase).toEqual({ type: "idle", lastResult: undefined });
  });
  it("is running/streaming during a turn and idle/completed after it", async () => {
    const { core, mockClient } = createAgentWithMock();
    void core.send([{ type: "user", text: "hello" }]);
    const stream = await mockClient.awaitStream();
    await pollUntil(() => {
      if (core.phase.type === "running") return true;
      throw new Error(`waiting for running, currently: ${core.phase.type}`);
    });
    const running = core.phase;
    if (running.type !== "running") throw new Error("expected running");
    expect(running.activity.type).toBe("streaming");
    stream.streamText("hi");
    stream.finishResponse("end_turn");
    await pollUntil(() => {
      if (core.phase.type === "idle") return true;
      throw new Error(`waiting for idle, currently: ${core.phase.type}`);
    });
    expect(core.phase).toEqual({
      type: "idle",
      lastResult: { type: "completed", stopReason: "end_turn" },
    });
  });
  it("reports a failed submission as idle with the resubmit text", async () => {
    const { core, mockClient } = createAgentWithMock();
    void core.send([{ type: "user", text: "find the bug" }]);
    const stream = await mockClient.awaitStream();
    stream.respondWithError(new Error("provider failure"));
    await pollUntil(() => {
      if (core.phase.type === "idle") return true;
      throw new Error(`waiting for idle, currently: ${core.phase.type}`);
    });
    const phase = core.phase;
    if (phase.type !== "idle") throw new Error("expected idle");
    expect(phase.lastResult?.type).toBe("failed");
    if (phase.lastResult?.type !== "failed") throw new Error("expected failed");
    expect(phase.lastResult.error.message).toBe("provider failure");
  });

  it("reports an aborted turn as idle with an aborted result", async () => {
    const { core, mockClient } = createAgentWithMock();
    void core.send([{ type: "user", text: "hello" }]);
    const stream = await mockClient.awaitStream();
    stream.streamText("partial");
    await core.abort();
    await pollUntil(() => {
      if (core.phase.type === "idle") return true;
      throw new Error(`waiting for idle, currently: ${core.phase.type}`);
    });
    expect(core.phase).toEqual({
      type: "idle",
      lastResult: { type: "aborted" },
    });
  });

  it("is running/awaiting_tools when tools run outside the runner's view", () => {
    const { core } = createAgentWithMock();
    const activeTools = new Map<ToolRequestId, ActiveToolEntry>();
    activeTools.set("tool-await" as ToolRequestId, {
      handle: undefined as unknown as ActiveToolEntry["handle"],
      progress: undefined,
      toolName: "bash" as ToolName,
      request: {
        id: "tool-await" as ToolRequestId,
        toolName: "bash" as ToolName,
        input: {},
      } as ActiveToolEntry["request"],
    });
    core.state.mode = { type: "tool_use", activeTools };
    expect(core.phase).toEqual({
      type: "running",
      activity: { type: "awaiting_tools", activeTools },
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
    void core.send([{ type: "user", text: "do the task" }]);
    const stream = await mockClient.awaitStream();
    stream.streamToolUse(
      "tool-phase-structured" as ToolRequestId,
      "yield_to_parent" as ToolName,
      { count: 3 },
    );
    stream.finishResponse("end_turn");
    await pollUntil(() => {
      if (core.state.mode.type === "yielded") return true;
      throw new Error("waiting for yield");
    });
    expect(core.phase).toEqual({
      type: "idle",
      lastResult: {
        type: "yielded",
        value: { type: "structured", value: { count: 3 } },
      },
    });
  });

  it("reports a yield as an idle thread with a yielded result", async () => {
    const { core, mockClient } = createAgentWithMock({
      threadType: "subagent" as ThreadType,
    });
    void core.send([{ type: "user", text: "do the task" }]);
    const stream = await mockClient.awaitStream();
    stream.streamToolUse(
      "tool-phase-yield" as ToolRequestId,
      "yield_to_parent" as ToolName,
      { result: "done" },
    );
    stream.finishResponse("end_turn");
    await pollUntil(() => {
      if (core.state.mode.type === "yielded") return true;
      throw new Error("waiting for yield");
    });
    expect(core.phase).toEqual({
      type: "idle",
      lastResult: { type: "yielded", value: { type: "text", text: "done" } },
    });
  });
});
describe("Thread.send result", () => {
  it("resolves completed when the agent reaches end_turn", async () => {
    const { core, mockClient } = createAgentWithMock();
    const result = core.send([{ type: "user", text: "hello" }]);
    const stream = await mockClient.awaitStream();
    stream.streamText("hi");
    stream.finishResponse("end_turn");
    expect(await result).toEqual({ type: "completed", stopReason: "end_turn" });
  });
  it("resolves yielded with the text a plain yield produced", async () => {
    const { core, mockClient } = createAgentWithMock({
      threadType: "subagent" as ThreadType,
    });
    const result = core.send([{ type: "user", text: "do the task" }]);
    const stream = await mockClient.awaitStream();
    stream.streamToolUse(
      "send-yield-text" as ToolRequestId,
      "yield_to_parent" as ToolName,
      { result: "done" },
    );
    stream.finishResponse("end_turn");
    expect(await result).toEqual({
      type: "yielded",
      value: { type: "text", text: "done" },
    });
  });
  it("resolves yielded with the structured value a schema'd yield produced", async () => {
    const { core, mockClient } = createAgentWithMock({
      threadType: "subagent" as ThreadType,
      yieldSchema: {
        type: "object",
        properties: { count: { type: "number" } },
        required: ["count"],
      },
    });
    const result = core.send([{ type: "user", text: "do the task" }]);
    const stream = await mockClient.awaitStream();
    stream.streamToolUse(
      "send-yield-structured" as ToolRequestId,
      "yield_to_parent" as ToolName,
      { count: 3 },
    );
    stream.finishResponse("end_turn");
    expect(await result).toEqual({
      type: "yielded",
      value: { type: "structured", value: { count: 3 } },
    });
  });
  it("resolves aborted when the turn is aborted", async () => {
    const { core, mockClient } = createAgentWithMock();
    const result = core.send([{ type: "user", text: "hello" }]);
    const stream = await mockClient.awaitStream();
    stream.streamText("partial");
    await core.abort();
    expect(await result).toEqual({ type: "aborted" });
  });
  it("resolves failed on a non-retryable error", async () => {
    const { core, mockClient } = createAgentWithMock();
    const result = core.send([{ type: "user", text: "find the bug" }]);
    const stream = await mockClient.awaitStream();
    stream.respondWithError(new Error("provider failure"));
    const settled = await result;
    if (settled.type !== "failed") throw new Error("expected failed");
    expect(settled.error.message).toBe("provider failure");
  });
  it("resolves completed rather than hanging when there is nothing to send", async () => {
    const { core } = createAgentWithMock();
    expect(await core.send([])).toEqual({
      type: "completed",
      stopReason: undefined,
    });
  });
  it("resolves completed rather than hanging on an empty raw send", async () => {
    const { core } = createAgentWithMock({
      threadType: "compact" as ThreadType,
    });
    expect(await core.send([])).toEqual({
      type: "completed",
      stopReason: undefined,
    });
  });
  it("rejects once the thread's container has been torn down", async () => {
    const { core } = createAgentWithMock({
      threadType: "subagent" as ThreadType,
    });
    core.state.mode = {
      type: "yielded",
      response: "done",
      value: { type: "text", text: "done" },
      tornDown: true,
    };
    await expect(core.send([{ type: "user", text: "more" }])).rejects.toThrow(
      /torn down/,
    );
  });
  it("reports a queued send as queued rather than borrowing another submission's outcome", async () => {
    const { core, mockClient } = createAgentWithMock();
    const first = core.send([{ type: "user", text: "hello" }]);
    const stream = await mockClient.awaitStream();
    expect(
      await core.send([{ type: "user", text: "and also" }], {
        queue: "async",
      }),
    ).toEqual({ type: "queued" });
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
        return {
          compact: false,
          messages: [{ type: "user" as const, text: renderPending(message) }],
          reminders: [],
        };
      },
    );
    const sent = core.send([{ type: "user", text: "start" }]);
    const stream = await mockClient.awaitStream();
    expect(
      await core.submit(pendingMessage("queued follow-up"), "next"),
    ).toEqual({ type: "queued" });
    stream.streamText("ok");
    stream.finishResponse("end_turn");
    // The agent has settled and is idle; the loop is inside the flush that
    // will build the continuation. A send arriving now must not start a
    // concurrent turn.
    await entered;
    const streamsBefore = mockClient.streams.length;
    expect(core.isBusy).toBe(true);
    expect(await core.submit(pendingMessage("racer"), "async")).toEqual({
      type: "queued",
    });
    expect(mockClient.streams.length).toBe(streamsBefore);
    releaseResolve?.();
    const second = await awaitNextStream(mockClient, stream);
    second.streamText("done");
    second.finishResponse("end_turn");
    // The racer was queued, so it goes out as its own continuation.
    const third = await awaitNextStream(mockClient, second);
    third.streamText("done again");
    third.finishResponse("end_turn");
    expect(await sent).toEqual({ type: "completed", stopReason: "end_turn" });
  });
  it("delivers a queued message before an end-turn supervisor can suspend", async () => {
    const threadId = uniqueThreadId("queue-beats-suspend");
    const { core, mockClient } = createAgentWithMock(undefined, threadId);
    core.hooks = composeSupervisors(() => [
      {
        onEndTurnWithoutYield: () => ({
          type: "suspend" as const,
          reason: { kind: "stop" as const, message: "halt" },
        }),
      },
    ]);
    const sent = core.send([{ type: "user", text: "start" }]);
    const stream = await mockClient.awaitStream();
    expect(
      await core.submit(pendingMessage("queued follow-up"), "next"),
    ).toEqual({ type: "queued" });
    stream.streamText("ok");
    stream.finishResponse("end_turn");
    // The queue is consulted first: the suspension has to wait for the thread
    // to actually come to rest.
    const second = await awaitNextStream(mockClient, stream);
    expect(JSON.stringify(second.messages)).toContain("queued follow-up");
    second.streamText("done");
    second.finishResponse("end_turn");
    expect(await sent).toEqual({
      type: "suspended",
      reason: { kind: "stop", message: "halt" },
    });
    await core.destroy();
    await cleanupArchive(threadId);
  });
  it("does not offer the submitted text back when a continuation fails", async () => {
    const { core, mockClient } = createAgentWithMock(
      undefined,
      uniqueThreadId("continuation-failure"),
    );
    core.hooks = composeSupervisors(() => [new MaxTokensSupervisor()]);
    const sent = core.send([{ type: "user", text: "original message" }]);
    const stream = await mockClient.awaitStream();
    stream.streamText("truncated");
    stream.finishResponse("max_tokens");
    const continuation = await awaitNextStream(mockClient, stream);
    continuation.respondWithError(new Error("continuation failure"));
    const result = await sent;
    if (result.type !== "failed") throw new Error("expected failed");
    // The rollback only reached the continuation request, so the submitted
    // message is still in the log and must not also be restored for resubmit.
    expect(result.discardedSubmission).toBe(false);
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
/** Stand in for the `runSubmission` loop: record the compaction suspensions a
 * submission produces, without actually summarizing anything. */
function trackCompactions(core: Thread): { prompts: (string | undefined)[] } {
  const prompts: (string | undefined)[] = [];
  const realSend = core.send.bind(core);
  core.send = (...args: Parameters<Thread["send"]>) =>
    realSend(...args).then((r) => {
      if (r.type === "suspended") {
        if (r.reason.kind === "compact") prompts.push(r.reason.nextPrompt);
      }
      return r;
    });
  return { prompts };
}

describe("runSubmission across a compaction handoff", () => {
  /** A compactor that summarizes without talking to a provider. */
  const stubCompactor = (
    outcome: CompactionOutcome = {
      type: "complete",
      summary: "SUMMARY TEXT",
      chunkCount: 1,
    },
  ): Compactor & { calls: (string | undefined)[] } => {
    const calls: (string | undefined)[] = [];
    return {
      calls,
      run: (_messages, nextPrompt) => {
        calls.push(nextPrompt);
        return Promise.resolve(outcome);
      },
    };
  };

  /** Suspends once, at the first stop. */
  const compactOnce = (core: Thread, nextPrompt: string | undefined) => {
    let asked = false;
    core.hooks = composeSupervisors(() => [
      {
        onEndTurnWithoutYield: () => {
          if (asked) return { type: "none" as const };
          asked = true;
          return {
            type: "suspend" as const,
            reason: { kind: "compact", nextPrompt },
          };
        },
      },
    ]);
  };

  it("stays pending until the post-compaction turn comes to rest", async () => {
    const threadId = uniqueThreadId("send-compaction");
    const { core, mockClient } = createAgentWithMock(undefined, threadId);
    try {
      compactOnce(core, "carry on");
      const compactor = stubCompactor();
      const oldAgent = core.agent;
      let settled: ThreadSendResult | undefined;
      const result = runSubmission({
        thread: core,
        compactor,
        start: () => core.send([{ type: "user", text: "hello" }]),
      });
      void result.then((r) => {
        settled = r;
      });
      const stream = await mockClient.awaitStream();
      stream.streamText("done");
      stream.finishResponse("end_turn");
      const contStream = await pollUntil(() => {
        if (core.agent === oldAgent) throw new Error("waiting for swap");
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
      await cleanupArchive(threadId);
    }
  });

  it("falls back to the default continuation when the prompt resolves to nothing", async () => {
    const threadId = uniqueThreadId("send-compaction-empty-prompt");
    const { core, mockClient } = createAgentWithMock(undefined, threadId);
    try {
      // The owner resolves the `@compact` prompt at handoff time; a prompt made
      // entirely of commands can expand to nothing, and an empty user turn is
      // not something to send.
      compactOnce(core, "   ");
      const oldAgent = core.agent;
      const result = runSubmission({
        thread: core,
        compactor: stubCompactor(),
        start: () => core.send([{ type: "user", text: "hello" }]),
      });
      const stream = await mockClient.awaitStream();
      stream.streamText("done");
      stream.finishResponse("end_turn");
      const contStream = await pollUntil(() => {
        if (core.agent === oldAgent) throw new Error("waiting for swap");
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
      await cleanupArchive(threadId);
    }
  });

  it("stays pending across two consecutive handoffs, reseeding each time", async () => {
    const threadId = uniqueThreadId("send-compaction-twice");
    const { core, mockClient } = createAgentWithMock(undefined, threadId);
    try {
      const prompts = ["first continuation", "second continuation"];
      let handoffs = 0;
      core.hooks = composeSupervisors(() => [
        {
          onEndTurnWithoutYield: () => {
            if (handoffs >= prompts.length) return { type: "none" as const };
            const nextPrompt = prompts[handoffs];
            handoffs++;
            return {
              type: "suspend" as const,
              reason: { kind: "compact" as const, nextPrompt },
            };
          },
        },
      ]);
      const calls: (string | undefined)[] = [];
      const compactor: Compactor = {
        run: (_messages, nextPrompt) => {
          calls.push(nextPrompt);
          return Promise.resolve({
            type: "complete",
            summary: `SUMMARY ${calls.length}`,
            chunkCount: 1,
          });
        },
      };
      let settled: ThreadSendResult | undefined;
      const result = runSubmission({
        thread: core,
        compactor,
        start: () => core.send([{ type: "user", text: "hello" }]),
      });
      void result.then((r) => {
        settled = r;
      });

      let stream = await mockClient.awaitStream();
      for (const [idx, prompt] of prompts.entries()) {
        const oldAgent = core.agent;
        stream.streamText("done");
        stream.finishResponse("end_turn");
        const prev = stream;
        stream = await pollUntil(() => {
          if (core.agent === oldAgent) throw new Error("waiting for swap");
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
      await cleanupArchive(threadId);
    }
  });

  it("resolves failed when the summarizing pass errors out", async () => {
    const threadId = uniqueThreadId("compaction-error");
    const { core, mockClient } = createAgentWithMock(undefined, threadId);
    try {
      compactOnce(core, undefined);
      const result = runSubmission({
        thread: core,
        compactor: stubCompactor({ type: "error", message: "boom" }),
        start: () => core.send([{ type: "user", text: "hello" }]),
      });
      const stream = await mockClient.awaitStream();
      stream.streamText("done");
      stream.finishResponse("end_turn");
      expect(await result).toMatchObject({ type: "failed" });
    } finally {
      await core.destroy();
      await cleanupArchive(threadId);
    }
  });

  it("treats a suspension nobody claims as a plain stop", async () => {
    const threadId = uniqueThreadId("suspend-unclaimed");
    const { core, mockClient } = createAgentWithMock(undefined, threadId);
    try {
      let asked = false;
      core.hooks = composeSupervisors(() => [
        {
          onEndTurnWithoutYield: () => {
            if (asked) return { type: "none" as const };
            asked = true;
            return {
              type: "suspend" as const,
              reason: { kind: "stop" as const, message: "budget exhausted" },
            };
          },
        },
      ]);
      const compactor = stubCompactor();
      const result = runSubmission({
        thread: core,
        compactor,
        start: () => core.send([{ type: "user", text: "hello" }]),
      });
      const stream = await mockClient.awaitStream();
      stream.streamText("done");
      stream.finishResponse("end_turn");
      expect(await result).toEqual({
        type: "completed",
        stopReason: undefined,
      });
      expect(compactor.calls).toEqual([]);
      // The log is coherent and resumable: a fresh send just continues.
      const next = core.send([{ type: "user", text: "again" }]);
      const stream2 = await awaitNextStream(mockClient, stream);
      stream2.streamText("ok");
      stream2.finishResponse("end_turn");
      expect(await next).toEqual({ type: "completed", stopReason: "end_turn" });
    } finally {
      await core.destroy();
      await cleanupArchive(threadId);
    }
  });
});

describe("Thread.reset", () => {
  it("starts a fresh agent from the seed and keeps the thread's durables", async () => {
    const threadId = uniqueThreadId("thread-reset");
    const { core, mockClient } = createAgentWithMock(undefined, threadId);
    try {
      const sent = core.send([{ type: "user", text: "the old conversation" }]);
      const stream = await mockClient.awaitStream();
      stream.streamText("old reply");
      stream.finishResponse("end_turn");
      await sent;

      core.structuredToolResults.set("tr-1" as ToolRequestId, {
        toolName: "edl" as ToolName,
      });
      const oldAgent = core.agent;

      await core.reset({
        seed: [
          {
            type: "text",
            text: "SEED",
            nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
          },
        ],
        archive: { type: "none" },
      });

      expect(core.agent).not.toBe(oldAgent);
      expect(core.getProviderMessages()).toEqual([]);
      expect(core.structuredToolResults.has("tr-1" as ToolRequestId)).toBe(
        true,
      );
      // The registers belong to the message list being replaced: a saved
      // fragment refers to text the fresh agent has never seen.
      expect(core.state.edlRegisters.registers.size).toBe(0);

      void core.send([{ type: "user", text: "continue" }]);
      const next = await awaitNextStream(mockClient, stream);
      const body = JSON.stringify(next.messages);
      expect(body).toContain("SEED");
      expect(body).not.toContain("the old conversation");
      next.streamText("ok");
      next.finishResponse("end_turn");
    } finally {
      await core.destroy();
      await cleanupArchive(threadId);
    }
  });

  it("with no seed and no archive record, starts an empty agent silently", async () => {
    const threadId = uniqueThreadId("thread-reset-bare");
    const { core, mockClient } = createAgentWithMock(undefined, threadId);
    try {
      const sent = core.send([{ type: "user", text: "the old conversation" }]);
      const stream = await mockClient.awaitStream();
      stream.streamText("old reply");
      stream.finishResponse("end_turn");
      await sent;
      await core.awaitArchiveFlush();

      await core.reset({ seed: [], archive: { type: "none" } });

      expect(core.getProviderMessages()).toEqual([]);
      const entries = await readArchive(threadId);
      expect(entries.map((e) => e.type)).not.toContain("compaction");

      void core.send([{ type: "user", text: "continue" }]);
      const next = await awaitNextStream(mockClient, stream);
      expect(JSON.stringify(next.messages)).not.toContain(
        "the old conversation",
      );
      next.streamText("ok");
      next.finishResponse("end_turn");
    } finally {
      await core.destroy();
      await cleanupArchive(threadId);
    }
  });
});

describe("Agent.handleProviderStopped", () => {
  it("max_tokens with completed tool_use block routes through handleProviderStoppedWithToolUse", async () => {
    const { core, mockClient } = createAgentWithMock({
      threadType: "subagent" as ThreadType,
    });

    void core.send([{ type: "user", text: "do the task" }]);
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
      if (core.state.mode.type === "yielded") return true;
      throw new Error(
        `waiting for yielded mode, currently: ${core.state.mode.type}`,
      );
    });

    expect(core.state.mode.type).toBe("yielded");
    if (core.state.mode.type === "yielded") {
      expect(core.state.mode.response).toBe("Here is the result of my work");
    }
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

    void core.send([{ type: "user", text: "do the task" }]);
    const stream = await mockClient.awaitStream();

    const toolUseId = "tool-yield-structured" as ToolRequestId;
    stream.streamToolUse(toolUseId, "yield_to_parent" as ToolName, {
      count: 3,
    });
    stream.finishResponse("max_tokens");

    await pollUntil(() => {
      if (core.state.mode.type === "yielded") return true;
      throw new Error(
        `waiting for yielded mode, currently: ${core.state.mode.type}`,
      );
    });

    expect(core.state.mode.type).toBe("yielded");
    if (core.state.mode.type === "yielded") {
      expect(JSON.parse(core.state.mode.response)).toEqual({ count: 3 });
    }
  });
  it("max_tokens with truncated (incomplete) tool_use block sends error tool_result and auto-continues", async () => {
    const { core, mockClient } = createAgentWithMock();

    void core.send([{ type: "user", text: "hello" }]);
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
    const { core, mockClient } = createAgentWithMock();
    core.hooks = composeSupervisors(() => [new MaxTokensSupervisor()]);

    void core.send([{ type: "user", text: "hello" }]);
    const stream = await mockClient.awaitStream();
    stream.streamText("Here is a long response that got");
    stream.finishResponse("max_tokens");

    const nextStream = await awaitNextStream(mockClient, stream);
    expect(lastUserText(nextStream)).toContain("truncated");
  });

  it("is the only supervisor to speak on max_tokens, and spends no restart", async () => {
    const { core, mockClient } = createAgentWithMock();
    const unsupervised = new UnsupervisedSupervisor();
    core.hooks = composeSupervisors(() => [
      new MaxTokensSupervisor(),
      unsupervised,
    ]);

    void core.send([{ type: "user", text: "hello" }]);
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
      threadType: "subagent" as ThreadType,
    });
    core.hooks = composeSupervisors(() => [
      new MaxTokensSupervisor(),
      new SubagentSupervisor(),
    ]);
    void core.send([{ type: "user", text: "do the task" }]);
    const stream = await mockClient.awaitStream();
    stream.streamText("<yield>partial resu");
    stream.finishResponse("max_tokens");
    const continuation = await awaitNextStream(mockClient, stream);
    const continuationText = lastUserText(continuation);
    expect(continuationText).toContain("truncated");
    expect(continuationText).not.toContain("XML tags in your response");
  });
});

describe("Agent.abort on yielded thread", () => {
  it("abort is a no-op when thread has already yielded", async () => {
    const { core, mockClient } = createAgentWithMock({
      threadType: "subagent" as ThreadType,
    });

    void core.send([{ type: "user", text: "do the task" }]);
    const stream = await mockClient.awaitStream();

    const toolUseId = "tool-yield-1" as ToolRequestId;

    // Drive the thread to yielded state
    stream.streamToolUse(toolUseId, "yield_to_parent" as ToolName, {
      result: "Here is the result of my work",
    });
    stream.finishResponse("tool_use");

    await pollUntil(() => {
      if (core.state.mode.type === "yielded") return true;
      throw new Error(
        `waiting for yielded mode, currently: ${core.state.mode.type}`,
      );
    });

    expect(core.state.mode.type).toBe("yielded");

    // Now abort — should be a no-op
    await core.abort();

    // Mode should still be yielded with the original response
    expect(core.state.mode.type).toBe("yielded");
    if (core.state.mode.type === "yielded") {
      expect(core.state.mode.response).toBe("Here is the result of my work");
    }
  });
});

describe("Agent.abort appends user abort message", () => {
  it("appends abort message when aborting during streaming", async () => {
    const { core, mockClient } = createAgentWithMock();

    void core.send([{ type: "user", text: "hello" }]);
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
      } as unknown as AgentContext["fileIO"],
    });

    void core.send([{ type: "user", text: "hello" }]);
    const stream = await mockClient.awaitStream();

    const toolUseId = "tool-abort-1" as ToolRequestId;

    // Stream a tool_use block and finish with tool_use stop reason
    stream.streamToolUse(toolUseId, "get_files" as ToolName, {
      files: [{ filePath: "/tmp/test.txt" }],
    });
    stream.finishResponse("tool_use");

    // Wait for tool_use mode
    await pollUntil(() => {
      if (core.state.mode.type === "tool_use") return true;
      throw new Error(
        `waiting for tool_use mode, currently: ${core.state.mode.type}`,
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

    // There should also be a tool_result error message before the abort message
    const secondToLast = messages[messages.length - 2];
    expect(secondToLast.role).toBe("user");
    expect(secondToLast.content).toEqual(
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
      threadType: "subagent" as ThreadType,
    });
    core.hooks = composeSupervisors(() => [new SubagentSupervisor()]);

    void core.send([{ type: "user", text: "do the task" }]);
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
      threadType: "subagent" as ThreadType,
    });
    core.hooks = composeSupervisors(() => [new SubagentSupervisor()]);

    void core.send([{ type: "user", text: "do the task" }]);
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

describe("AutoCompactSupervisor integration", () => {
  it("triggers compaction on end_turn handoff when input tokens breach the threshold", async () => {
    const { core, mockClient } = createAgentWithMock();
    core.hooks = composeSupervisors(() => [
      new AutoCompactSupervisor({ threshold: 100, nextPrompt: "go" }),
    ]);
    mockClient.mockInputTokenCount = 50;

    const compactions = trackCompactions(core);

    void core.send([{ type: "user", text: "hello" }]);
    const stream = await mockClient.awaitStream();
    stream.streamText("done");
    stream.finishResponse("end_turn");

    // inputTokenCount is populated post-flight, so it lags one turn. Drive a
    // second turn; the handoff at its end sees the over-threshold count.
    await pollUntil(() => {
      if (core.runner.log.inputTokenCount === 50) return true;
      throw new Error("waiting for token count");
    });
    mockClient.mockInputTokenCount = 200;

    void core.send([{ type: "user", text: "again" }]);
    const stream2 = await awaitNextStream(mockClient, stream);
    stream2.streamText("done again");
    stream2.finishResponse("end_turn");

    await pollUntil(() => {
      if (compactions.prompts.length > 0) return true;
      throw new Error("waiting for compaction");
    });

    expect(compactions.prompts.length).toBe(1);
  });

  it("does not trigger compaction when input tokens are below the threshold", async () => {
    const { core, mockClient } = createAgentWithMock();
    core.hooks = composeSupervisors(() => [
      new AutoCompactSupervisor({ threshold: 100000, nextPrompt: "go" }),
    ]);
    mockClient.mockInputTokenCount = 50;

    const compactions = trackCompactions(core);

    void core.send([{ type: "user", text: "hello" }]);
    const stream = await mockClient.awaitStream();
    stream.streamText("done");
    stream.finishResponse("end_turn", { inputTokens: 50, outputTokens: 5 });

    await pollUntil(() => {
      if (core.runner.phase.type !== "idle") throw new Error("waiting");
      return true;
    });

    expect(compactions.prompts.length).toBe(0);
  });

  it("triggers compaction on a tool_use handoff after tools resolve", async () => {
    const fileIO = new InMemoryFileIO({ "/tmp/a.txt": "hello" });
    const { core, mockClient } = createAgentWithMock({
      fileIO: fileIO as unknown as AgentContext["fileIO"],
    });
    core.hooks = composeSupervisors(() => [
      new AutoCompactSupervisor({ threshold: 100, nextPrompt: "go" }),
    ]);
    mockClient.mockInputTokenCount = 50;

    const compactions = trackCompactions(core);

    // First turn populates the post-flight inputTokenCount.
    void core.send([{ type: "user", text: "hello" }]);
    const stream = await mockClient.awaitStream();
    stream.streamText("done");
    stream.finishResponse("end_turn");
    await pollUntil(() => {
      if (core.runner.log.inputTokenCount === 50) return true;
      throw new Error("waiting for token count");
    });
    mockClient.mockInputTokenCount = 200;

    // Second turn ends with a tool_use. After the tool resolves, the tool_use
    // handoff sees the over-threshold count and triggers compaction rather
    // than continuing the conversation.
    void core.send([{ type: "user", text: "edit a" }]);
    const stream2 = await awaitNextStream(mockClient, stream);
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

  it("triggers compaction on a max_tokens handoff when over threshold", async () => {
    const { core, mockClient } = createAgentWithMock();
    core.hooks = composeSupervisors(() => [
      new AutoCompactSupervisor({ threshold: 100, nextPrompt: "go" }),
    ]);
    mockClient.mockInputTokenCount = 50;

    const compactions = trackCompactions(core);

    void core.send([{ type: "user", text: "hello" }]);
    const stream = await mockClient.awaitStream();
    stream.streamText("done");
    stream.finishResponse("end_turn");
    await pollUntil(() => {
      if (core.runner.log.inputTokenCount === 50) return true;
      throw new Error("waiting for token count");
    });
    mockClient.mockInputTokenCount = 200;

    // A max_tokens stop without a tool_use block routes through the handoff
    // check before the truncation-continue path.
    void core.send([{ type: "user", text: "again" }]);
    const stream2 = await awaitNextStream(mockClient, stream);
    stream2.streamText("partial");
    stream2.finishResponse("max_tokens");

    await pollUntil(() => {
      if (compactions.prompts.length > 0) return true;
      throw new Error("waiting for compaction");
    });
    expect(compactions.prompts.length).toBe(1);
  });

  it("appends an injected text to the message log", async () => {
    const { core, mockClient } = createAgentWithMock();
    let injected = false;
    core.hooks = composeSupervisors(() => [
      {
        onBeforeRequest: () => {
          if (injected) return Promise.resolve({ type: "none" as const });
          injected = true;
          return Promise.resolve(injectText("remember this"));
        },
      },
    ]);
    void core.send([{ type: "user", text: "hello" }]);
    const stream = await mockClient.awaitStream();
    stream.streamText("done");
    stream.finishResponse("end_turn");
    await pollUntil(() => {
      if (injected) return true;
      throw new Error("waiting for injection");
    });
    void core.send([{ type: "user", text: "next" }]);
    const stream2 = await awaitNextStream(mockClient, stream);
    expect(JSON.stringify(stream2.messages)).toContain("remember this");
    stream2.streamText("ok");
    stream2.finishResponse("end_turn");
  });

  it("injects an image on the tool_use continuation, after the tool result", async () => {
    const fileIO = new InMemoryFileIO({ "/tmp/a.txt": "hello" });
    const { core, mockClient } = createAgentWithMock({
      fileIO: fileIO as unknown as AgentContext["fileIO"],
    });
    let injected = false;
    core.hooks = composeSupervisors(() => [
      {
        onBeforeRequest: (ctx) => {
          if (
            injected ||
            ctx.kind !== "continuation" ||
            ctx.stopReason !== "tool_use"
          ) {
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
                nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
              },
            ],
          });
        },
      },
    ]);
    void core.send([{ type: "user", text: "edit a" }]);
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
    const { core, mockClient } = createAgentWithMock();
    let asked = false;
    core.hooks = composeSupervisors(() => [
      // max_tokens plans a continuation, so the stop reaches the
      // before-request supervisors at all.
      new MaxTokensSupervisor(),
      {
        onBeforeRequest: (ctx) => {
          if (asked || ctx.kind === "submission")
            return Promise.resolve({ type: "none" as const });
          asked = true;
          return Promise.resolve(injectText("note"));
        },
      },
      {
        onBeforeRequest: () =>
          Promise.resolve(
            asked
              ? {
                  type: "suspend" as const,
                  reason: { kind: "compact", nextPrompt: "carry on" },
                }
              : { type: "none" as const },
          ),
      },
    ]);
    const compactions = trackCompactions(core);
    void core.send([{ type: "user", text: "hello" }]);
    const stream = await mockClient.awaitStream();
    stream.streamText("partial");
    stream.finishResponse("max_tokens");
    await pollUntil(() => {
      if (compactions.prompts.length > 0) return true;
      throw new Error("waiting for compaction");
    });
    expect(compactions.prompts.length).toBe(1);
    expect(compactions.prompts[0]).toBe("carry on");
    // Exactly once: the snapshot handed to the compaction manager is
    // `getProviderMessages()`, and nothing is left in agent-local state that
    // the swap would either drop or replay.
    expect(countOccurrences(core.getProviderMessages(), "note")).toBe(1);
  });
  it("appends a tool_use-path injection immediately when a compaction follows", async () => {
    const fileIO = new InMemoryFileIO({ "/tmp/a.txt": "hello" });
    const { core, mockClient } = createAgentWithMock({
      fileIO: fileIO as unknown as AgentContext["fileIO"],
    });
    let asked = false;
    core.hooks = composeSupervisors(() => [
      {
        onBeforeRequest: (ctx) => {
          if (
            asked ||
            ctx.kind !== "continuation" ||
            ctx.stopReason !== "tool_use"
          ) {
            return Promise.resolve({ type: "none" as const });
          }
          asked = true;
          return Promise.resolve(injectText("tool-path note"));
        },
      },
      {
        onBeforeRequest: () =>
          Promise.resolve(
            asked
              ? {
                  type: "suspend" as const,
                  reason: { kind: "compact", nextPrompt: "carry on" },
                }
              : { type: "none" as const },
          ),
      },
    ]);
    const compactions = trackCompactions(core);
    void core.send([{ type: "user", text: "edit a" }]);
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
    const { core, mockClient } = createAgentWithMock();
    let injected = false;
    core.hooks = composeSupervisors(() => [
      {
        onBeforeRequest: () => {
          if (injected) return Promise.resolve({ type: "none" as const });
          injected = true;
          return Promise.resolve(injectText("survive the failure"));
        },
      },
    ]);
    void core.send([{ type: "user", text: "hello" }]);
    const stream = await mockClient.awaitStream();
    stream.streamText("done");
    stream.finishResponse("end_turn");
    await pollUntil(() => {
      if (injected) return true;
      throw new Error("waiting for injection");
    });
    void core.send([{ type: "user", text: "next" }]);
    const stream2 = await awaitNextStream(mockClient, stream);
    stream2.respondWithError(new Error("provider failure"));
    await pollUntil(() => {
      if (core.phase.type === "idle") return true;
      throw new Error("waiting for idle");
    });
    expect(
      countOccurrences(core.getProviderMessages(), "survive the failure"),
    ).toBe(1);
    void core.send([{ type: "user", text: "retry" }]);
    const stream3 = await awaitNextStream(mockClient, stream2);
    expect(countOccurrences(stream3.messages, "survive the failure")).toBe(1);
    stream3.streamText("ok");
    stream3.finishResponse("end_turn");
  });
  it("keeps an injection in the log when the next request is aborted", async () => {
    const { core, mockClient } = createAgentWithMock();
    let injected = false;
    core.hooks = composeSupervisors(() => [
      {
        onBeforeRequest: () => {
          if (injected) return Promise.resolve({ type: "none" as const });
          injected = true;
          return Promise.resolve(injectText("survive the abort"));
        },
      },
    ]);
    void core.send([{ type: "user", text: "hello" }]);
    const stream = await mockClient.awaitStream();
    stream.streamText("done");
    stream.finishResponse("end_turn");
    await pollUntil(() => {
      if (injected) return true;
      throw new Error("waiting for injection");
    });
    void core.send([{ type: "user", text: "next" }]);
    const stream2 = await awaitNextStream(mockClient, stream);
    stream2.streamText("partial");
    await core.abort();
    await pollUntil(() => {
      if (core.phase.type === "idle") return true;
      throw new Error("waiting for idle");
    });
    expect(
      countOccurrences(core.getProviderMessages(), "survive the abort"),
    ).toBe(1);
    void core.send([{ type: "user", text: "retry" }]);
    const stream3 = await awaitNextStream(mockClient, stream2);
    expect(countOccurrences(stream3.messages, "survive the abort")).toBe(1);
    stream3.streamText("ok");
    stream3.finishResponse("end_turn");
  });

  it("consults all supervisors in order and the first compaction wins", async () => {
    const { core, mockClient } = createAgentWithMock();
    const calls: string[] = [];
    const first: ThreadSupervisor = {
      onEndTurnWithoutYield: () => {
        calls.push("first");
        return { type: "none" };
      },
    };
    const second: ThreadSupervisor = {
      onEndTurnWithoutYield: () => {
        calls.push("second");
        return {
          type: "suspend",
          reason: { kind: "compact", nextPrompt: "go" },
        };
      },
    };
    const third: ThreadSupervisor = {
      onEndTurnWithoutYield: () => {
        calls.push("third");
        return {
          type: "suspend",
          reason: { kind: "compact", nextPrompt: "stop" },
        };
      },
    };
    core.hooks = composeSupervisors(() => [first, second, third]);

    const compactions = trackCompactions(core);

    void core.send([{ type: "user", text: "hello" }]);
    const stream = await mockClient.awaitStream();
    stream.streamText("done");
    stream.finishResponse("end_turn");

    await pollUntil(() => {
      if (calls.includes("third")) return true;
      throw new Error("waiting for supervisor consultation");
    });

    expect(calls).toEqual(["first", "second", "third"]);
    expect(compactions.prompts[0]).toBe("go");
  });

  it("injects on the opening request of a send, ahead of the user content", async () => {
    const { core, mockClient } = createAgentWithMock();
    const kinds: string[] = [];
    core.hooks = composeSupervisors(() => [
      {
        onBeforeRequest: (ctx) => {
          kinds.push(ctx.kind);
          return Promise.resolve(
            ctx.kind === "submission"
              ? injectText("submission note")
              : { type: "none" as const },
          );
        },
      },
    ]);

    void core.send([{ type: "user", text: "hello" }]);
    const stream = await mockClient.awaitStream();

    expect(kinds[0]).toBe("submission");
    const serialized = JSON.stringify(stream.messages);
    expect(serialized).toContain("submission note");
    expect(serialized.indexOf("submission note")).toBeLessThan(
      serialized.indexOf("hello"),
    );

    stream.streamText("ok");
    stream.finishResponse("end_turn");
  });

  it("consults onBeforeRequest exactly once per request across a handoff", async () => {
    const { core, mockClient } = createAgentWithMock();
    const kinds: string[] = [];
    core.hooks = composeSupervisors(() => [
      new MaxTokensSupervisor(),
      {
        onBeforeRequest: (ctx) => {
          kinds.push(ctx.kind);
          return Promise.resolve({ type: "none" as const });
        },
      },
    ]);

    void core.send([{ type: "user", text: "hello" }]);
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
    expect(kinds).toEqual(["submission", "continuation"]);
  });
  it("reports the provider's stop reason on a continuation that carries tool results", async () => {
    const { core, mockClient } = createAgentWithMock();
    const contexts: string[] = [];
    core.hooks = composeSupervisors(() => [
      {
        onBeforeRequest: (ctx) => {
          contexts.push(
            ctx.kind === "continuation"
              ? `continuation:${ctx.stopReason}`
              : ctx.kind,
          );
          return Promise.resolve({ type: "none" as const });
        },
      },
    ]);
    void core.send([{ type: "user", text: "hello" }]);
    const stream = await mockClient.awaitStream();
    // Tools were requested, but the response was cut short by the token limit:
    // the continuation carries the results under the provider's own stop
    // reason, not a hardcoded "tool_use".
    stream.streamToolUse(
      "tool-truncated" as ToolRequestId,
      "get_files" as ToolName,
      { files: [{ filePath: "/tmp/test.txt" }] },
    );
    stream.finishResponse("max_tokens");
    const nextStream = await awaitNextStream(mockClient, stream);
    expect(contexts).toEqual(["submission", "continuation:max_tokens"]);
    nextStream.streamText("done");
    nextStream.finishResponse("end_turn");
  });

  it("does not consult onBeforeRequest at a stop that issues no request", async () => {
    const { core, mockClient } = createAgentWithMock();
    const kinds: string[] = [];
    core.hooks = composeSupervisors(() => [
      {
        onBeforeRequest: (ctx) => {
          kinds.push(ctx.kind);
          return Promise.resolve({ type: "none" as const });
        },
      },
    ]);
    void core.send([{ type: "user", text: "hello" }]);
    const stream = await mockClient.awaitStream();
    // A queued async message means the end_turn stop still issues a request.
    void core.send([{ type: "user", text: "and this" }], { queue: "async" });
    stream.streamText("ok");
    stream.finishResponse("end_turn");
    const nextStream = await awaitNextStream(mockClient, stream);
    expect(kinds).toEqual(["submission", "continuation"]);
    // This stop has nothing left to send.
    nextStream.streamText("done");
    nextStream.finishResponse("end_turn");
    await pollUntil(() => {
      if (!core.isBusy) return true;
      throw new Error("waiting for the thread to come to rest");
    });
    expect(kinds).toEqual(["submission", "continuation"]);
  });

  it("reports tool results before the continuation's before-request hook, with output tokens", async () => {
    const { core, mockClient } = createAgentWithMock();
    const events: string[] = [];
    let continuationOutputTokens: number | undefined;
    core.hooks = {
      onToolResults: (results) => {
        events.push(`results:${results.size}`);
      },
      onBeforeRequest: (ctx) => {
        events.push(`request:${ctx.kind}`);
        if (ctx.kind === "continuation") {
          continuationOutputTokens = ctx.outputTokenCount;
        }
        return Promise.resolve({
          type: "proceed" as const,
          injections: [],
        });
      },
    };
    void core.send([{ type: "user", text: "hello" }]);
    const stream = await mockClient.awaitStream();
    stream.streamToolUse("edl-1" as ToolRequestId, "edl" as ToolName, {
      script: "nonsense",
    });
    stream.finishResponse("tool_use", { inputTokens: 1, outputTokens: 42 });
    const nextStream = await awaitNextStream(mockClient, stream);
    expect(events).toEqual([
      "request:submission",
      "results:1",
      "request:continuation",
    ]);
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
      fileIO: {
        readFile: async () => "file contents",
        writeFile: async () => {},
        fileExists: async () => true,
        stat: async () => statPromise,
      } as unknown as AgentContext["fileIO"],
    });
    const events: string[] = [];
    core.hooks = {
      onToolResults: (results) => {
        events.push(`results:${results.size}`);
      },
      onBeforeRequest: (ctx) => {
        events.push(`request:${ctx.kind}`);
        return Promise.resolve({ type: "proceed" as const, injections: [] });
      },
    };
    void core.send([{ type: "user", text: "hello" }]);
    const stream = await mockClient.awaitStream();
    stream.streamToolUse("get-1" as ToolRequestId, "get_files" as ToolName, {
      files: [{ filePath: "/tmp/test.txt" }],
    });
    stream.finishResponse("tool_use");
    await pollUntil(() => {
      if (core.state.mode.type === "tool_use") return true;
      throw new Error(
        `waiting for tool_use mode, currently: ${core.state.mode.type}`,
      );
    });
    const abortPromise = core.abort();
    resolveStat();
    await abortPromise;
    // The results are reported, and no continuation request follows them.
    expect(events).toEqual(["request:submission", "results:1"]);
  });
  it("reports tool results when the turn yields instead of continuing", async () => {
    const { core, mockClient } = createAgentWithMock({
      threadType: "subagent",
    });
    const events: string[] = [];
    core.hooks = {
      onToolResults: (results) => {
        events.push(`results:${results.size}`);
      },
      onBeforeRequest: (ctx) => {
        events.push(`request:${ctx.kind}`);
        return Promise.resolve({ type: "proceed" as const, injections: [] });
      },
    };
    void core.send([{ type: "user", text: "hello" }]);
    const stream = await mockClient.awaitStream();
    stream.streamToolUse(
      "yield-1" as ToolRequestId,
      "yield_to_parent" as ToolName,
      { result: "all done" },
    );
    stream.finishResponse("tool_use");
    await pollUntil(() => {
      if (core.state.mode.type === "yielded") return true;
      throw new Error(
        `waiting for yielded mode, currently: ${core.state.mode.type}`,
      );
    });
    expect(events).toEqual(["request:submission", "results:1"]);
  });

  it("issues a request for a submission-time injection with no user content", async () => {
    const { core, mockClient } = createAgentWithMock();
    core.hooks = composeSupervisors(() => [
      {
        hasPendingContent: () => Promise.resolve(true),
        onBeforeRequest: (ctx) =>
          Promise.resolve(
            ctx.kind === "submission"
              ? injectText("solo note")
              : { type: "none" as const },
          ),
      },
    ]);

    void core.send([]);
    const stream = await mockClient.awaitStream();
    expect(JSON.stringify(stream.messages)).toContain("solo note");
    stream.streamText("ok");
    stream.finishResponse("end_turn");
  });

  it("compacts from a plain send, exactly once, when already over threshold", async () => {
    const { core, mockClient } = createAgentWithMock();
    core.hooks = composeSupervisors(() => [
      new AutoCompactSupervisor({ threshold: 100, nextPrompt: "go" }),
    ]);
    mockClient.mockInputTokenCount = 200;

    const compactions = trackCompactions(core);

    // First turn populates the post-flight inputTokenCount.
    void core.send([{ type: "user", text: "hello" }]);
    const stream = await mockClient.awaitStream();
    stream.streamText("done");
    stream.finishResponse("end_turn");
    await pollUntil(() => {
      if (compactions.prompts.length > 0) return true;
      throw new Error("waiting for the end-turn compaction");
    });
    expect(compactions.prompts.length).toBe(1);

    // The next send is over threshold before its first request goes out, so
    // the submission consult compacts instead of issuing it — once.
    compactions.prompts.length = 0;
    void core.send([{ type: "user", text: "again" }]);
    await pollUntil(() => {
      if (compactions.prompts.length > 0) return true;
      throw new Error("waiting for the submission compaction");
    });
    expect(compactions.prompts.length).toBe(1);
    // The user's message is in the log the compaction snapshot is taken from.
    expect(JSON.stringify(core.getProviderMessages())).toContain("again");
  });
});

describe("AgentHooks.onToolApplied", () => {
  it("fires for edl edits and get_files reads, alongside editedFilesThisTurn", async () => {
    const fileIO = new InMemoryFileIO({
      "/tmp/a.txt": "hello",
      "/tmp/b.txt": "other",
    });
    const { core, mockClient } = createAgentWithMock({
      fileIO: fileIO as unknown as AgentContext["fileIO"],
    });
    const applied: {
      supervisor: number;
      path: AbsFilePath;
      type: ToolApplied["type"];
    }[] = [];
    const collector = (supervisor: number): ThreadSupervisor => ({
      onToolApplied: (absFilePath, tool) => {
        applied.push({ supervisor, path: absFilePath, type: tool.type });
      },
    });
    core.hooks = composeSupervisors(() => [collector(0), collector(1)]);

    void core.send([{ type: "user", text: "edit a" }]);
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
    expect(core.state.editedFilesThisTurn).toEqual([
      { path: "/tmp/a.txt", snapshot: "hello" },
    ]);
  });

  it("keeps editedFilesThisTurn bookkeeping when a subscriber throws", async () => {
    const fileIO = new InMemoryFileIO({ "/tmp/a.txt": "hello" });
    const { core, mockClient } = createAgentWithMock({
      fileIO: fileIO as unknown as AgentContext["fileIO"],
    });
    core.hooks = composeSupervisors(() => [
      {
        onToolApplied: () => {
          throw new Error("subscriber blew up");
        },
      },
    ]);

    void core.send([{ type: "user", text: "edit a" }]);
    const stream = await mockClient.awaitStream();
    stream.streamToolUse("edl-1" as ToolRequestId, "edl" as ToolName, {
      script: `file \`/tmp/a.txt\`\nnarrow /hello/\nreplace "bye"`,
    });
    stream.finishResponse("tool_use");

    await pollUntil(() => {
      if (core.state.editedFilesThisTurn.length === 1) return true;
      throw new Error("waiting for the edited-file bookkeeping");
    });
    expect(core.state.editedFilesThisTurn).toEqual([
      { path: "/tmp/a.txt", snapshot: "hello" },
    ]);
  });
});
describe("Agent.editedFilesThisTurn", () => {
  it("starts empty and resets on new sendMessage", async () => {
    const fileIO = new InMemoryFileIO({ "/tmp/a.txt": "hello" });
    const { core, mockClient } = createAgentWithMock({
      fileIO: fileIO as unknown as AgentContext["fileIO"],
    });

    expect(core.state.editedFilesThisTurn).toEqual([]);

    void core.send([{ type: "user", text: "edit a" }]);
    const stream = await mockClient.awaitStream();
    stream.streamToolUse("edl-1" as ToolRequestId, "edl" as ToolName, {
      script: `file \`/tmp/a.txt\`\nnarrow /hello/\nreplace "bye"`,
    });
    stream.finishResponse("tool_use");

    await pollUntil(() => {
      if (core.state.editedFilesThisTurn.length === 1) return true;
      throw new Error(
        `waiting for 1 edited file, got ${core.state.editedFilesThisTurn.length}`,
      );
    });
    expect(core.state.editedFilesThisTurn).toEqual([
      { path: "/tmp/a.txt", snapshot: "hello" },
    ]);

    void core.send([{ type: "user", text: "next turn" }]);
    await mockClient.awaitStream();
    expect(core.state.editedFilesThisTurn).toEqual([]);
  });

  it("keeps the pre-turn snapshot after a second edit to the same file", async () => {
    const fileIO = new InMemoryFileIO({ "/tmp/a.txt": "hello" });
    const { core, mockClient } = createAgentWithMock({
      fileIO: fileIO as unknown as AgentContext["fileIO"],
    });
    void core.send([{ type: "user", text: "edit a" }]);
    const stream = await mockClient.awaitStream();
    stream.streamToolUse("edl-1" as ToolRequestId, "edl" as ToolName, {
      script: `file \`/tmp/a.txt\`\nnarrow /hello/\nreplace "bye"`,
    });
    stream.finishResponse("tool_use");
    await pollUntil(() => {
      if (core.state.editedFilesThisTurn.length === 1) return true;
      throw new Error(
        `waiting for 1 edited file, got ${core.state.editedFilesThisTurn.length}`,
      );
    });
    const stream2 = await awaitNextStream(mockClient, stream);
    stream2.streamToolUse("edl-2" as ToolRequestId, "edl" as ToolName, {
      script: `file \`/tmp/a.txt\`\nnarrow /bye/\nreplace "done"`,
    });
    stream2.finishResponse("tool_use");
    await pollUntil(async () => {
      const content = await fileIO.readFile(
        "/tmp/a.txt" as unknown as Parameters<typeof fileIO.readFile>[0],
      );
      if (content === "done") return true;
      throw new Error(`waiting for second edit, got ${content}`);
    });
    expect(core.state.editedFilesThisTurn).toEqual([
      { path: "/tmp/a.txt", snapshot: "hello" },
    ]);
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

describe("Agent bash summary reminder", () => {
  it("fires the bash reminder on the first abbreviated bash output", async () => {
    const { shell } = createMockShell(makeAbbreviatedShellResult());
    const { core, mockClient } = createAgentWithMock({
      shell: shell as unknown as AgentContext["shell"],
    });

    void core.send([{ type: "user", text: "run a thing" }]);
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
      shell: shell as unknown as AgentContext["shell"],
    });

    void core.send([{ type: "user", text: "run a thing" }]);
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
      shell: shell as unknown as AgentContext["shell"],
    });

    void core.send([{ type: "user", text: "first" }]);
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
  it("applies subagentConfig.effort to thinking when creating agent", () => {
    const captured: AgentOptions[] = [];
    const spyProvider: Provider = {
      createAgent(options: AgentOptions): Runner {
        captured.push(options);
        const mockClient = new MockAnthropicClient();
        return new AnthropicRunner(
          options,
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
      getProvider: () => spyProvider,
    });

    expect(captured.length).toBe(1);
    expect(captured[0].thinking).toBeDefined();
    expect(captured[0].thinking?.effort).toBe("max");
    expect(captured[0].thinking?.enabled).toBe(true);
  });

  it("force-enables thinking when profile.thinking is unset but subagent has effort", () => {
    const captured: AgentOptions[] = [];
    const spyProvider: Provider = {
      createAgent(options: AgentOptions): Runner {
        captured.push(options);
        const mockClient = new MockAnthropicClient();
        return new AnthropicRunner(
          options,
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
      getProvider: () => spyProvider,
    });

    expect(captured[0].thinking?.effort).toBe("max");
    expect(captured[0].thinking?.enabled).toBe(true);
  });

  it("uses profile.thinking unchanged when no subagentConfig.effort override", () => {
    const captured: AgentOptions[] = [];
    const spyProvider: Provider = {
      createAgent(options: AgentOptions): Runner {
        captured.push(options);
        const mockClient = new MockAnthropicClient();
        return new AnthropicRunner(
          options,
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
      getProvider: () => spyProvider,
    });

    expect(captured[0].thinking?.effort).toBe("high");
  });
});

describe("Agent failure rollback", () => {
  /** Drive a send to a provider error and wait for the agent to come to rest. */
  const failSend = async (
    core: Thread,
    mockClient: MockAnthropicClient,
    text: string,
    error = new Error("provider failure"),
  ) => {
    const prev = mockClient.streams[mockClient.streams.length - 1];
    const result = core.send([{ type: "user", text }]);
    const stream = await awaitNextStream(mockClient, prev);
    stream.respondWithError(error);
    return await result;
  };

  it("rolls the log back so a resubmit does not duplicate the user message", async () => {
    const { core, mockClient } = createAgentWithMock();
    const failed = await failSend(core, mockClient, "find the bug");
    expect(failed.type).toBe("failed");
    expect(core.getProviderMessages()).toHaveLength(0);

    void core.send([{ type: "user", text: "try again" }]);
    await mockClient.awaitStream();
    const userTexts = core
      .getProviderMessages()
      .filter((m) => m.role === "user")
      .flatMap((m) => m.content)
      .filter((c) => c.type === "text")
      .map((c) => c.text);
    expect(userTexts.filter((t) => t.includes("find the bug"))).toHaveLength(0);
    expect(userTexts.filter((t) => t.includes("try again"))).toHaveLength(1);
  });

  it("rolls back to the snapshot, keeping earlier completed exchanges", async () => {
    const { core, mockClient } = createAgentWithMock();
    void core.send([{ type: "user", text: "first message" }]);
    const first = await mockClient.awaitStream();
    first.respond({ text: "hi", toolRequests: [], stopReason: "end_turn" });
    await pollUntil(() => {
      if (core.getProviderMessages().length === 2) return true;
      throw new Error("waiting for the first exchange");
    });

    await failSend(core, mockClient, "second message");
    const messages = core.getProviderMessages();
    expect(messages).toHaveLength(2);
    expect(messages[1].role).toBe("assistant");
  });

  it("leaves both queues populated and unresolved, delivering them on the next send", async () => {
    const { core, mockClient } = createAgentWithMock(
      undefined,
      uniqueThreadId("failure-queues"),
    );
    void core.send([{ type: "user", text: "find the bug" }]);
    const stream = await mockClient.awaitStream();
    void core.send([{ type: "user", text: "also check the logs" }], {
      queue: "async",
    });
    void core.send([{ type: "user", text: "and the config" }], {
      queue: "next",
    });
    expect(core.queued.async).toHaveLength(1);
    expect(core.queued.next).toHaveLength(1);

    stream.respondWithError(new Error("provider failure"));
    await pollUntil(() => {
      if (core.state.lastTurnResult?.type === "failed") return true;
      throw new Error("waiting for error state");
    });
    // The queued entries were never delivered, so they stay queued.
    expect(core.queued.async).toHaveLength(1);
    expect(core.queued.next).toHaveLength(1);

    void core.send([{ type: "user", text: "retry" }]);
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
      void core.send([{ type: "user", text: "flaky task" }]);
      await vi.advanceTimersByTimeAsync(0);
      const stream = await mockClient.awaitStream();
      // "terminated" is retryable, so exhaust the runner's own retry budget
      // first: what reaches the agent is a runner that has already given up.
      vi.setSystemTime(new Date(Date.now() + 300_001));
      stream.respondWithError(new Error("terminated"));
      await vi.advanceTimersByTimeAsync(0);
      expect(core.state.lastTurnResult?.type).toBe("failed");
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
    const settled: SendResult[] = [];
    void core
      .send([{ type: "user", text: "flaky task" }])
      .then((r) => settled.push(r as SendResult));
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
    void core.send([{ type: "user", text: "read it" }]);
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
      if (core.state.lastTurnResult?.type === "failed") return true;
      throw new Error("waiting for error state");
    });
    for (const message of core.getProviderMessages()) {
      for (const content of message.content) {
        if (content.type === "tool_use") {
          throw new Error("expected no orphan tool_use in the rolled-back log");
        }
      }
    }
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
      void core.send([{ type: "user", text: "edit a" }]);
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
        if (core.runner.phase.type !== "idle") throw new Error("waiting");
        return true;
      });
      await core.awaitArchiveFlush();

      const entries = await readArchive(threadId);
      expect(entries[0].type).toBe("thread_start");

      const messages = entries.filter((e) => e.type === "message");
      const serialized = JSON.stringify(messages);
      expect(serialized).toContain('"type":"tool_use"');
      expect(serialized).toContain('"type":"tool_result"');
      expect(serialized).toContain("/tmp/a.txt");
    } finally {
      await core.destroy();
      await cleanupArchive(threadId);
    }
  });

  it("persists completed messages mid-turn but withholds the streaming one", async () => {
    const threadId = uniqueThreadId("archive-withhold");
    const fileIO = new InMemoryFileIO({ "/tmp/a.txt": "hello" });
    const { core, mockClient } = createAgentWithMock({ fileIO }, threadId);

    try {
      void core.send([{ type: "user", text: "edit a" }]);
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
      await core.awaitArchiveFlush();

      const midSerialized = JSON.stringify(
        (await readArchive(threadId)).filter((e) => e.type === "message"),
      );
      expect(midSerialized).toContain('"type":"tool_use"');
      expect(midSerialized).not.toContain("streaming-reply");

      nextStream.finishResponse("end_turn");
      await pollUntil(() => {
        if (core.runner.phase.type !== "idle") throw new Error("waiting");
        return true;
      });
      await core.awaitArchiveFlush();

      const finalSerialized = JSON.stringify(
        (await readArchive(threadId)).filter((e) => e.type === "message"),
      );
      expect(finalSerialized).toContain('"type":"tool_result"');
      expect(finalSerialized).toContain("streaming-reply");
    } finally {
      await core.destroy();
      await cleanupArchive(threadId);
    }
  });

  it("inserts a compaction marker between agent generations and keeps appending", async () => {
    const threadId = uniqueThreadId("archive-compact");
    const { core, mockClient } = createAgentWithMock(undefined, threadId);

    try {
      void core.send([{ type: "user", text: "first turn" }]);
      const stream = await mockClient.awaitStream();
      stream.streamText("done");
      stream.finishResponse("end_turn");

      await pollUntil(() => {
        if (core.runner.phase.type !== "idle") throw new Error("waiting");
        return true;
      });
      await core.awaitArchiveFlush();

      const compactPromise = runSubmission({
        thread: core,
        compactor: {
          run: () =>
            Promise.resolve({
              type: "complete",
              summary: "SUMMARY TEXT",
              chunkCount: 2,
            }),
        },
        start: () =>
          Promise.resolve({
            type: "suspended",
            reason: { kind: "compact", nextPrompt: undefined },
          }),
      });

      const contStream = await pollUntil(() => {
        if (mockClient.streams.length < 2) throw new Error("waiting");
        return mockClient.streams[1];
      });
      contStream.streamText("resumed");
      contStream.finishResponse("end_turn");
      await compactPromise;
      await pollUntil(() => {
        if (core.runner.phase.type !== "idle") throw new Error("waiting");
        return true;
      });
      await core.awaitArchiveFlush();

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
      void parent.send([{ type: "user", text: "parent turn" }]);
      const stream = await mockClient.awaitStream();
      stream.streamText("parent response");
      stream.finishResponse("end_turn");

      await pollUntil(() => {
        if (parent.runner.phase.type !== "idle") throw new Error("waiting");
        return true;
      });

      const nativeMessageIdx = parent.runner.getNativeMessageIdx();
      child = await Thread.clone({
        sourceThread: parent,
        newId: childId,
        nativeMessageIdx,
        context,
        callbacks: { onUpdate: () => {}, resolve: resolveAsText },
      });

      void child.send([{ type: "user", text: "child turn" }]);
      const childStream = await pollUntil(() => {
        const s = mockClient.streams[mockClient.streams.length - 1];
        if (!s || s === stream) throw new Error("waiting");
        return s;
      });
      childStream.streamText("child response");
      childStream.finishResponse("end_turn");

      await pollUntil(() => {
        if (child!.runner.phase.type !== "idle") throw new Error("waiting");
        return true;
      });
      await child.awaitArchiveFlush();
      await parent.awaitArchiveFlush();

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
      void parent.send([{ type: "user", text: "parent turn" }]);
      const stream = await mockClient.awaitStream();
      stream.streamText("parent response");
      stream.finishResponse("end_turn");
      await pollUntil(() => {
        if (parent.runner.phase.type !== "idle") throw new Error("waiting");
        return true;
      });

      parent.state.edlRegisters.registers.set("r", "regval");
      parent.state.edlRegisters.nextSavedId = 3;

      const nativeMessageIdx = parent.runner.getNativeMessageIdx();
      child = await Thread.clone({
        sourceThread: parent,
        newId: childId,
        nativeMessageIdx,
        context,
        callbacks: { onUpdate: () => {}, resolve: resolveAsText },
      });

      expect(child.state.edlRegisters.registers.get("r")).toBe("regval");
      expect(child.state.edlRegisters.nextSavedId).toBe(3);

      child.state.edlRegisters.registers.set("r2", "x");
      expect(parent.state.edlRegisters.registers.has("r2")).toBe(false);
    } finally {
      await parent.destroy();
      if (child) await child.destroy();
      await cleanupArchive(parentId);
      await cleanupArchive(childId);
    }
  });
});

describe("Thread survives the compaction agent swap", () => {
  /** Drive a compaction handoff to completion, including the post-compaction
   * continuation turn the fresh agent issues. */
  async function compact(
    core: Thread,
    mockClient: MockAnthropicClient,
  ): Promise<void> {
    const streamsBefore = mockClient.streams.length;
    const compactPromise = runSubmission({
      thread: core,
      compactor: {
        run: () =>
          Promise.resolve({
            type: "complete",
            summary: "SUMMARY TEXT",
            chunkCount: 1,
          }),
      },
      // Nothing to run: the suspension is the point.
      start: () =>
        Promise.resolve({
          type: "suspended",
          reason: { kind: "compact", nextPrompt: undefined },
        }),
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
      if (core.runner.phase.type !== "idle") throw new Error("waiting");
      return true;
    });
  }

  it("keeps structured tool results recorded before the compaction", async () => {
    const threadId = uniqueThreadId("compact-structured");
    const { core, mockClient } = createAgentWithMock(undefined, threadId);
    try {
      const map = core.structuredToolResults;
      map.set(
        "req-1" as ToolRequestId,
        {
          toolName: "thread_title" as ToolName,
        } as never,
      );
      await compact(core, mockClient);
      expect(core.structuredToolResults).toBe(map);
      expect(core.structuredToolResults.has("req-1" as ToolRequestId)).toBe(
        true,
      );
    } finally {
      await core.destroy();
      await cleanupArchive(threadId);
    }
  });

  it("forwards events from the replacement agent and none from the old one", async () => {
    const threadId = uniqueThreadId("compact-events");
    const { core, mockClient } = createAgentWithMock(undefined, threadId);
    try {
      const oldAgent = core.agent;
      await compact(core, mockClient);
      expect(core.agent).not.toBe(oldAgent);

      let updates = 0;
      core.callbacks.onUpdate = () => updates++;
      core.agent.update({ type: "set-title", title: "after compaction" });
      expect(updates).toBe(1);
    } finally {
      await core.destroy();
      await cleanupArchive(threadId);
    }
  });

  it("seeds the replacement agent's prefix with the summary alone", async () => {
    const threadId = uniqueThreadId("compact-prefix");
    const { core, mockClient } = createAgentWithMock(undefined, threadId);
    try {
      // Queued on the pre-compaction agent, which the swap discards: the
      // prefix belongs to the message list being replaced.
      core.prependToNextTurn([
        {
          type: "text",
          text: "stale prefix",
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
        },
      ]);
      const compactPromise = runSubmission({
        thread: core,
        compactor: {
          run: () =>
            Promise.resolve({
              type: "complete",
              summary: "SUMMARY TEXT",
              chunkCount: 1,
            }),
        },
        start: () =>
          Promise.resolve({
            type: "suspended",
            reason: { kind: "compact", nextPrompt: undefined },
          }),
      });
      const contStream = await mockClient.awaitStream();
      const texts = core.pendingTurnContent.map((c) =>
        c.type === "text" ? c.text : "",
      );
      expect(texts.some((t) => t.includes("stale prefix"))).toBe(false);
      contStream.streamText("resumed");
      contStream.finishResponse("end_turn");
      await compactPromise;
      await pollUntil(() => {
        if (core.runner.phase.type !== "idle") throw new Error("waiting");
        return true;
      });
    } finally {
      await core.destroy();
      await cleanupArchive(threadId);
    }
  });
});
