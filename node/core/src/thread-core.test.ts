import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OutputLine, Shell, ShellResult } from "./capabilities/shell.ts";
import type { ThreadId, ThreadType } from "./chat-types.ts";
import { InMemoryFileIO } from "./edl/in-memory-file-io.ts";
import type { Logger } from "./logger.ts";
import type { ProviderProfile } from "./provider-options.ts";
import {
  AnthropicAgent,
  type AnthropicAgentOptions,
} from "./providers/anthropic-agent.ts";
import { MockAnthropicClient } from "./providers/mock-anthropic-client.ts";
import type {
  Agent,
  AgentOptions,
  Provider,
} from "./providers/provider-types.ts";
import type { SystemPrompt } from "./providers/system-prompt.ts";
import { ThreadCore, type ThreadCoreContext } from "./thread-core.ts";
import {
  AutoCompactSupervisor,
  SubagentSupervisor,
  type ThreadSupervisor,
} from "./thread-supervisor.ts";
import type { ToolName, ToolRequestId } from "./tool-types.ts";
import { validateInput } from "./tools/helpers.ts";
import type { MCPToolManager } from "./tools/mcp/manager.ts";
import { pollUntil } from "./utils/async.ts";
import { threadConversationLogPath } from "./utils/files.ts";

const TEST_ARCHIVE_DIR = path.join(os.tmpdir(), "magenta-test-archive");

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  trace: () => {},
} as Logger;

const defaultAnthropicOptions: AnthropicAgentOptions = {
  authType: "max",
  includeWebSearch: false,
  disableParallelToolUseFlag: true,
  logger: noopLogger,
  validateInput,
};

function createMockProvider(mockClient: MockAnthropicClient): Provider {
  return {
    createAgent(options: AgentOptions): Agent {
      return new AnthropicAgent(
        options,
        mockClient as unknown as Anthropic,
        defaultAnthropicOptions,
      );
    },
    forceToolUse() {
      throw new Error("Not implemented in mock");
    },
  };
}

function createThreadCoreWithMock(
  overrides?: Partial<ThreadCoreContext>,
  threadId: ThreadId = "test-thread" as ThreadId,
): {
  core: ThreadCore;
  mockClient: MockAnthropicClient;
  context: ThreadCoreContext;
} {
  const mockClient = new MockAnthropicClient();
  const provider = createMockProvider(mockClient);
  const context: ThreadCoreContext = {
    logger: noopLogger,
    profile: {
      provider: "mock",
      model: "claude-3-5-sonnet-20241022",
    } as ProviderProfile,
    cwd: "/tmp" as ThreadCoreContext["cwd"],
    homeDir: "/home" as ThreadCoreContext["homeDir"],
    threadType: "root" as ThreadType,
    systemPrompt: "test system prompt" as unknown as SystemPrompt,
    systemInfo: {
      timestamp: "Mon Jan 01 2024 00:00:00 GMT+0000",
      platform: "linux",
      neovimVersion: "0.10.0",
      cwd: "/tmp" as ThreadCoreContext["cwd"],
    },
    mcpToolManager: {
      serverMap: {},
      getToolSpecs: () => [],
    } as unknown as MCPToolManager,
    threadManager: {
      getThread: () => undefined,
      getThreads: () => [],
    } as unknown as ThreadCoreContext["threadManager"],
    fileIO: {
      readFile: async () => "",
      writeFile: async () => {},
      fileExists: async () => false,
    } as unknown as ThreadCoreContext["fileIO"],
    shell: {
      exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    } as unknown as ThreadCoreContext["shell"],
    gitClient: {
      getState: async () => undefined,
    } as unknown as ThreadCoreContext["gitClient"],
    lspClient: {} as unknown as ThreadCoreContext["lspClient"],
    helpTagsProvider: {
      listTagFiles: async () => [],
    } as unknown as ThreadCoreContext["helpTagsProvider"],
    availableCapabilities: new Set(),
    environmentConfig: { type: "local" },
    maxConcurrentSubagents: 1,
    maxConcurrentFastSubagents: 8,
    getAgents: () => ({}),
    getProvider: () => provider,
    conversationLogBaseDir: TEST_ARCHIVE_DIR,
    ...overrides,
  };

  return {
    core: new ThreadCore(threadId, context),
    mockClient,
    context,
  };
}

describe("ThreadCore.handleProviderStopped", () => {
  it("max_tokens with completed tool_use block routes through handleProviderStoppedWithToolUse", async () => {
    const { core, mockClient } = createThreadCoreWithMock({
      threadType: "subagent" as ThreadType,
    });

    core.sendMessage([{ type: "user", text: "do the task" }]);
    const stream = await mockClient.awaitStream();

    const toolUseId = "tool-yield-1" as ToolRequestId;

    // Stream a yield_to_parent tool_use, then stop with max_tokens
    stream.streamToolUse(toolUseId, "yield_to_parent" as ToolName, {
      result: "Here is the result of my work",
    });
    stream.finishResponse("max_tokens");

    // ThreadCore should route to handleProviderStoppedWithToolUse,
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
    const { core, mockClient } = createThreadCoreWithMock({
      threadType: "subagent" as ThreadType,
      yieldSchema: {
        type: "object",
        properties: { count: { type: "number" } },
        required: ["count"],
      },
    });

    core.sendMessage([{ type: "user", text: "do the task" }]);
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
    const { core, mockClient } = createThreadCoreWithMock();

    core.sendMessage([{ type: "user", text: "hello" }]);
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
        name: "get_file" as ToolName,
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

  it("max_tokens with text-only content sends continuation prompt", async () => {
    const { core, mockClient } = createThreadCoreWithMock();

    core.sendMessage([{ type: "user", text: "hello" }]);
    const stream = await mockClient.awaitStream();

    // Stream only text, then stop with max_tokens
    stream.streamText("Here is a long response that got");
    stream.finishResponse("max_tokens");

    // ThreadCore should send a continuation system message and auto-continue
    const nextStream = await pollUntil(() => {
      const s = mockClient.streams[mockClient.streams.length - 1];
      if (s && s !== stream) return s;
      throw new Error("waiting for next stream");
    });

    // The next stream should contain the continuation prompt
    const lastUserMsg = nextStream.messages[nextStream.messages.length - 1];
    expect(lastUserMsg.role).toBe("user");
    const textBlocks = (
      lastUserMsg.content as Anthropic.Messages.ContentBlockParam[]
    ).filter((b): b is Anthropic.Messages.TextBlockParam => b.type === "text");
    expect(textBlocks.some((b) => b.text.includes("truncated"))).toBe(true);
  });
});

describe("ThreadCore.abort on yielded thread", () => {
  it("abort is a no-op when thread has already yielded", async () => {
    const { core, mockClient } = createThreadCoreWithMock({
      threadType: "subagent" as ThreadType,
    });

    core.sendMessage([{ type: "user", text: "do the task" }]);
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

describe("ThreadCore.abort appends user abort message", () => {
  it("appends abort message when aborting during streaming", async () => {
    const { core, mockClient } = createThreadCoreWithMock();

    core.sendMessage([{ type: "user", text: "hello" }]);
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
    const { core, mockClient } = createThreadCoreWithMock({
      fileIO: {
        readFile: async () => "file contents",
        writeFile: async () => {},
        fileExists: async () => true,
        stat: async () => statPromise,
      } as unknown as ThreadCoreContext["fileIO"],
    });

    core.sendMessage([{ type: "user", text: "hello" }]);
    const stream = await mockClient.awaitStream();

    const toolUseId = "tool-abort-1" as ToolRequestId;

    // Stream a tool_use block and finish with tool_use stop reason
    stream.streamToolUse(toolUseId, "get_file" as ToolName, {
      filePath: "/tmp/test.txt",
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

describe("ThreadCore.abort recovers pending messages", () => {
  it("drains pending messages and emits recoverPendingMessages on abort", async () => {
    const { core, mockClient } = createThreadCoreWithMock();
    const recovered: Array<{ threadId: ThreadId; text: string }> = [];
    core.on("recoverPendingMessages", (threadId, text) => {
      recovered.push({ threadId, text });
    });

    core.sendMessage([{ type: "user", text: "hello" }]);
    const stream = await mockClient.awaitStream();
    stream.streamText("partial response");

    core.update({
      type: "push-pending-messages",
      messages: [
        { type: "user", text: "queued one" },
        { type: "user", text: "queued two" },
      ],
    });

    await core.abort();

    expect(core.state.pendingMessages).toEqual([]);
    expect(recovered).toHaveLength(1);
    expect(recovered[0].threadId).toBe("test-thread");
    expect(recovered[0].text).toBe("queued one\nqueued two");
  });

  it("does not emit recoverPendingMessages when there are no pending messages", async () => {
    const { core, mockClient } = createThreadCoreWithMock();
    const recovered: Array<{ threadId: ThreadId; text: string }> = [];
    core.on("recoverPendingMessages", (threadId, text) => {
      recovered.push({ threadId, text });
    });

    core.sendMessage([{ type: "user", text: "hello" }]);
    const stream = await mockClient.awaitStream();
    stream.streamText("partial response");

    await core.abort();

    expect(recovered).toHaveLength(0);
    expect(core.state.pendingMessages).toEqual([]);
  });

  it("excludes system pending messages from recovered text", async () => {
    const { core, mockClient } = createThreadCoreWithMock();
    const recovered: Array<{ threadId: ThreadId; text: string }> = [];
    core.on("recoverPendingMessages", (threadId, text) => {
      recovered.push({ threadId, text });
    });
    core.sendMessage([{ type: "user", text: "hello" }]);
    const stream = await mockClient.awaitStream();
    stream.streamText("partial response");
    core.update({
      type: "push-pending-messages",
      messages: [
        { type: "user", text: "queued user" },
        { type: "system", text: "queued system" },
      ],
    });
    await core.abort();
    expect(core.state.pendingMessages).toEqual([]);
    expect(recovered).toHaveLength(1);
    expect(recovered[0].text).toBe("queued user");
  });
  it("does not emit recoverPendingMessages for subagent threads", async () => {
    const { core, mockClient } = createThreadCoreWithMock({
      threadType: "subagent" as ThreadType,
    });
    const recovered: Array<{ threadId: ThreadId; text: string }> = [];
    core.on("recoverPendingMessages", (threadId, text) => {
      recovered.push({ threadId, text });
    });

    core.sendMessage([{ type: "user", text: "do the task" }]);
    const stream = await mockClient.awaitStream();
    stream.streamText("partial response");

    core.update({
      type: "push-pending-messages",
      messages: [{ type: "user", text: "queued" }],
    });

    await core.abort();

    expect(recovered).toHaveLength(0);
    expect(core.state.pendingMessages).toEqual([]);
  });
});

describe("SubagentSupervisor yield tag detection", () => {
  it("nudges agent when it writes a <yield_to_parent> XML tag instead of calling the tool", async () => {
    const { core, mockClient } = createThreadCoreWithMock({
      threadType: "subagent" as ThreadType,
    });
    core.supervisors = [new SubagentSupervisor()];

    core.sendMessage([{ type: "user", text: "do the task" }]);
    const stream = await mockClient.awaitStream();

    // Agent writes a <yield> tag in text instead of calling the tool
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
    const { core, mockClient } = createThreadCoreWithMock({
      threadType: "subagent" as ThreadType,
    });
    core.supervisors = [new SubagentSupervisor()];

    core.sendMessage([{ type: "user", text: "do the task" }]);
    const stream = await mockClient.awaitStream();

    // Agent responds with normal text and stops
    stream.streamText("I have completed the task.");
    stream.finishResponse("end_turn");

    // Wait a tick to ensure no new stream is created
    await new Promise((r) => setTimeout(r, 50));
    expect(mockClient.streams.length).toBe(1);
  });
});

describe("AutoCompactSupervisor integration", () => {
  it("triggers compaction on end_turn handoff when input tokens breach the threshold", async () => {
    const { core, mockClient } = createThreadCoreWithMock();
    core.supervisors = [
      new AutoCompactSupervisor({ threshold: 100, nextPrompt: "go" }),
    ];
    mockClient.mockInputTokenCount = 200;

    let compactCalls = 0;
    core.startCompaction = () => {
      compactCalls++;
    };

    await core.sendMessage([{ type: "user", text: "hello" }]);
    const stream = await mockClient.awaitStream();
    stream.streamText("done");
    stream.finishResponse("end_turn");

    // inputTokenCount is populated post-flight, so it lags one turn. Drive a
    // second turn; the handoff at its end sees the over-threshold count.
    await pollUntil(() => {
      if (core.agent.getState().inputTokenCount === 200) return true;
      throw new Error("waiting for token count");
    });

    await core.sendMessage([{ type: "user", text: "again" }]);
    const stream2 = await mockClient.awaitStream();
    stream2.streamText("done again");
    stream2.finishResponse("end_turn");

    await pollUntil(() => {
      if (compactCalls > 0) return true;
      throw new Error("waiting for compaction");
    });

    expect(compactCalls).toBe(1);
  });

  it("does not trigger compaction when input tokens are below the threshold", async () => {
    const { core, mockClient } = createThreadCoreWithMock();
    core.supervisors = [
      new AutoCompactSupervisor({ threshold: 100000, nextPrompt: "go" }),
    ];
    mockClient.mockInputTokenCount = 50;

    let compactCalls = 0;
    core.startCompaction = () => {
      compactCalls++;
    };

    await core.sendMessage([{ type: "user", text: "hello" }]);
    const stream = await mockClient.awaitStream();
    stream.streamText("done");
    stream.finishResponse("end_turn", { inputTokens: 50, outputTokens: 5 });

    await pollUntil(() => {
      if (core.agent.getState().status.type !== "stopped")
        throw new Error("waiting");
      return true;
    });

    expect(compactCalls).toBe(0);
  });

  it("triggers compaction on a tool_use handoff after tools resolve", async () => {
    const fileIO = new InMemoryFileIO({ "/tmp/a.txt": "hello" });
    const { core, mockClient } = createThreadCoreWithMock({
      fileIO: fileIO as unknown as ThreadCoreContext["fileIO"],
    });
    core.supervisors = [
      new AutoCompactSupervisor({ threshold: 100, nextPrompt: "go" }),
    ];
    mockClient.mockInputTokenCount = 200;

    let compactCalls = 0;
    core.startCompaction = () => {
      compactCalls++;
    };

    // First turn populates the post-flight inputTokenCount.
    await core.sendMessage([{ type: "user", text: "hello" }]);
    const stream = await mockClient.awaitStream();
    stream.streamText("done");
    stream.finishResponse("end_turn");
    await pollUntil(() => {
      if (core.agent.getState().inputTokenCount === 200) return true;
      throw new Error("waiting for token count");
    });

    // Second turn ends with a tool_use. After the tool resolves, the tool_use
    // handoff sees the over-threshold count and triggers compaction rather
    // than continuing the conversation.
    await core.sendMessage([{ type: "user", text: "edit a" }]);
    const stream2 = await mockClient.awaitStream();
    stream2.streamToolUse("edl-1" as ToolRequestId, "edl" as ToolName, {
      script: `file \`/tmp/a.txt\`\nnarrow /hello/\nreplace "bye"`,
    });
    stream2.finishResponse("tool_use");

    await pollUntil(() => {
      if (compactCalls > 0) return true;
      throw new Error("waiting for compaction");
    });
    expect(compactCalls).toBe(1);
  });

  it("triggers compaction on a max_tokens handoff when over threshold", async () => {
    const { core, mockClient } = createThreadCoreWithMock();
    core.supervisors = [
      new AutoCompactSupervisor({ threshold: 100, nextPrompt: "go" }),
    ];
    mockClient.mockInputTokenCount = 200;

    let compactCalls = 0;
    core.startCompaction = () => {
      compactCalls++;
    };

    await core.sendMessage([{ type: "user", text: "hello" }]);
    const stream = await mockClient.awaitStream();
    stream.streamText("done");
    stream.finishResponse("end_turn");
    await pollUntil(() => {
      if (core.agent.getState().inputTokenCount === 200) return true;
      throw new Error("waiting for token count");
    });

    // A max_tokens stop without a tool_use block routes through the handoff
    // check before the truncation-continue path.
    await core.sendMessage([{ type: "user", text: "again" }]);
    const stream2 = await mockClient.awaitStream();
    stream2.streamText("partial");
    stream2.finishResponse("max_tokens");

    await pollUntil(() => {
      if (compactCalls > 0) return true;
      throw new Error("waiting for compaction");
    });
    expect(compactCalls).toBe(1);
  });

  it("consults all supervisors and combines their compact prompts in order", async () => {
    const { core, mockClient } = createThreadCoreWithMock();
    const calls: string[] = [];
    const first: ThreadSupervisor = {
      onHandoff: () => {
        calls.push("first");
        return { type: "none" };
      },
    };
    const second: ThreadSupervisor = {
      onHandoff: () => {
        calls.push("second");
        return { type: "compact", nextPrompt: "go" };
      },
    };
    const third: ThreadSupervisor = {
      onHandoff: () => {
        calls.push("third");
        return { type: "compact", nextPrompt: "stop" };
      },
    };
    core.supervisors = [first, second, third];

    let compactPrompt: string | undefined = "unset";
    core.startCompaction = (p?: string) => {
      compactPrompt = p;
    };

    await core.sendMessage([{ type: "user", text: "hello" }]);
    const stream = await mockClient.awaitStream();
    stream.streamText("done");
    stream.finishResponse("end_turn");

    await pollUntil(() => {
      if (calls.includes("third")) return true;
      throw new Error("waiting for supervisor consultation");
    });

    // All supervisors are consulted; compact prompts are combined in order.
    expect(calls).toEqual(["first", "second", "third"]);
    expect(compactPrompt).toBe("go\n\nstop");
  });
});

describe("ThreadCore.turnEnded event", () => {
  it("emits turnEnded with reason end_turn when agent stops cleanly", async () => {
    const { core, mockClient } = createThreadCoreWithMock();
    const events: Array<{ reason: string }> = [];
    core.on("turnEnded", (payload) => events.push(payload));

    await core.sendMessage([{ type: "user", text: "hello" }]);
    const stream = await mockClient.awaitStream();
    stream.streamText("done");
    stream.finishResponse("end_turn");

    await pollUntil(() => {
      if (events.length > 0) return true;
      throw new Error("waiting for turnEnded");
    });

    expect(events).toEqual([{ reason: "end_turn" }]);
  });

  it("emits turnEnded with reason aborted when user aborts", async () => {
    const { core, mockClient } = createThreadCoreWithMock();
    const events: Array<{ reason: string }> = [];
    core.on("turnEnded", (payload) => events.push(payload));

    await core.sendMessage([{ type: "user", text: "hello" }]);
    const stream = await mockClient.awaitStream();
    stream.streamText("partial");

    await core.abort();

    expect(events).toEqual([{ reason: "aborted" }]);
  });

  it("emits turnEnded with reason error when provider fails", async () => {
    const { core, mockClient } = createThreadCoreWithMock();
    const events: Array<{ reason: string }> = [];
    core.on("turnEnded", (payload) => events.push(payload));

    await core.sendMessage([{ type: "user", text: "hello" }]);
    const stream = await mockClient.awaitStream();
    stream.respondWithError(new Error("provider failure"));

    await pollUntil(() => {
      if (events.length > 0) return true;
      throw new Error("waiting for turnEnded");
    });

    expect(events).toEqual([{ reason: "error" }]);
  });
});

describe("ThreadCore.editedFilesThisTurn", () => {
  it("starts empty and resets on new sendMessage", async () => {
    const fileIO = new InMemoryFileIO({ "/tmp/a.txt": "hello" });
    const { core, mockClient } = createThreadCoreWithMock({
      fileIO: fileIO as unknown as ThreadCoreContext["fileIO"],
    });

    expect(core.state.editedFilesThisTurn).toEqual([]);

    await core.sendMessage([{ type: "user", text: "edit a" }]);
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

    await core.sendMessage([{ type: "user", text: "next turn" }]);
    expect(core.state.editedFilesThisTurn).toEqual([]);
  });

  it("keeps the pre-turn snapshot after a second edit to the same file", async () => {
    const fileIO = new InMemoryFileIO({ "/tmp/a.txt": "hello" });
    const { core, mockClient } = createThreadCoreWithMock({
      fileIO: fileIO as unknown as ThreadCoreContext["fileIO"],
    });
    await core.sendMessage([{ type: "user", text: "edit a" }]);
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
    const stream2 = await mockClient.awaitStream();
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

describe("ThreadCore bash summary reminder", () => {
  it("fires the bash reminder on the first abbreviated bash output", async () => {
    const { shell } = createMockShell(makeAbbreviatedShellResult());
    const { core, mockClient } = createThreadCoreWithMock({
      shell: shell as unknown as ThreadCoreContext["shell"],
    });

    await core.sendMessage([{ type: "user", text: "run a thing" }]);
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

  it("combines subsequent and bash reminders into a single <system-reminder> block when both gates fire", async () => {
    const { shell } = createMockShell(makeAbbreviatedShellResult());
    const { core, mockClient } = createThreadCoreWithMock({
      shell: shell as unknown as ThreadCoreContext["shell"],
    });

    await core.sendMessage([{ type: "user", text: "run a thing" }]);
    const stream = await mockClient.awaitStream();
    stream.streamToolUse(
      "tool-bash-1" as ToolRequestId,
      "bash_command" as ToolName,
      { command: "echo hi" },
    );
    // High output tokens to also fire the subsequent reminder gate.
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

  it("does not fire again below the token threshold, but fires after the threshold is crossed", async () => {
    const { shell, setNextResult } = createMockShell(
      makeAbbreviatedShellResult(),
    );
    const { core, mockClient } = createThreadCoreWithMock({
      shell: shell as unknown as ThreadCoreContext["shell"],
    });

    // First abbreviated bash → reminder should fire
    await core.sendMessage([{ type: "user", text: "first" }]);
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

    // Second abbreviated bash with few tokens → NO second reminder
    setNextResult(makeAbbreviatedShellResult());
    stream2.streamToolUse(
      "tool-bash-2" as ToolRequestId,
      "bash_command" as ToolName,
      { command: "echo hi" },
    );
    stream2.finishResponse("tool_use", { inputTokens: 1, outputTokens: 100 });

    const stream3 = await pollUntil(() => {
      const s = mockClient.streams[mockClient.streams.length - 1];
      if (s && s !== stream2) return s;
      throw new Error("waiting for third stream");
    });
    const lastUserMsg3 = stream3.messages[stream3.messages.length - 1];
    if (
      lastUserMsg3.role !== "user" ||
      typeof lastUserMsg3.content === "string"
    ) {
      throw new Error("expected structured user message");
    }
    const hasReminderInStream3 = (
      lastUserMsg3.content as Anthropic.ContentBlockParam[]
    )
      .filter(
        (b): b is Anthropic.TextBlockParam =>
          b.type === "text" && b.text.includes("<system-reminder>"),
      )
      .some(
        (b) =>
          b.text.includes("log file") && b.text.includes("bash_summarizer"),
      );
    expect(hasReminderInStream3).toBe(false);

    // Third bash with enough output tokens to cross the threshold → reminder fires again
    stream3.streamToolUse(
      "tool-bash-3" as ToolRequestId,
      "bash_command" as ToolName,
      { command: "echo hi" },
    );
    stream3.finishResponse("tool_use", { inputTokens: 1, outputTokens: 6000 });

    const stream4 = await pollUntil(() => {
      const s = mockClient.streams[mockClient.streams.length - 1];
      if (s && s !== stream3) return s;
      throw new Error("waiting for fourth stream");
    });
    const lastUserMsg4 = stream4.messages[stream4.messages.length - 1];
    if (
      lastUserMsg4.role !== "user" ||
      typeof lastUserMsg4.content === "string"
    ) {
      throw new Error("expected structured user message");
    }
    const hasReminderInStream4 = (
      lastUserMsg4.content as Anthropic.ContentBlockParam[]
    )
      .filter(
        (b): b is Anthropic.TextBlockParam =>
          b.type === "text" && b.text.includes("<system-reminder>"),
      )
      .some(
        (b) =>
          b.text.includes("log file") && b.text.includes("bash_summarizer"),
      );
    expect(hasReminderInStream4).toBe(true);
  });
});

describe("ThreadCore createFreshAgent thinking effort override", () => {
  it("applies subagentConfig.effort to thinking when creating agent", () => {
    const captured: AgentOptions[] = [];
    const spyProvider: Provider = {
      createAgent(options: AgentOptions): Agent {
        captured.push(options);
        const mockClient = new MockAnthropicClient();
        return new AnthropicAgent(
          options,
          mockClient as unknown as Anthropic,
          defaultAnthropicOptions,
        );
      },
      forceToolUse() {
        throw new Error("Not implemented in mock");
      },
    };

    createThreadCoreWithMock({
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
      createAgent(options: AgentOptions): Agent {
        captured.push(options);
        const mockClient = new MockAnthropicClient();
        return new AnthropicAgent(
          options,
          mockClient as unknown as Anthropic,
          defaultAnthropicOptions,
        );
      },
      forceToolUse() {
        throw new Error("Not implemented in mock");
      },
    };

    createThreadCoreWithMock({
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
      createAgent(options: AgentOptions): Agent {
        captured.push(options);
        const mockClient = new MockAnthropicClient();
        return new AnthropicAgent(
          options,
          mockClient as unknown as Anthropic,
          defaultAnthropicOptions,
        );
      },
      forceToolUse() {
        throw new Error("Not implemented in mock");
      },
    };

    createThreadCoreWithMock({
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

describe("ThreadCore non-retryable error resubmit flow", () => {
  it("emits setupResubmit with threadId and message text after error", async () => {
    const { core, mockClient } = createThreadCoreWithMock();
    const events: Array<{ threadId: ThreadId; text: string }> = [];
    core.on("setupResubmit", (threadId, text) => {
      events.push({ threadId, text });
    });

    await core.sendMessage([{ type: "user", text: "find the bug" }]);
    const stream = await mockClient.awaitStream();
    stream.respondWithError(new Error("provider failure"));

    await pollUntil(() => {
      if (events.length > 0) return true;
      throw new Error("waiting for setupResubmit");
    });

    expect(events).toHaveLength(1);
    expect(events[0].threadId).toBe("test-thread");
    expect(events[0].text).toContain("find the bug");
    expect(core.state.failedSubmit?.userMessage).toContain("find the bug");
    expect(core.state.failedSubmit?.errorMessage).toBe("provider failure");
  });

  it("does not set failedSubmit or emit setupResubmit for subagent threads", async () => {
    const { core, mockClient } = createThreadCoreWithMock({
      threadType: "subagent" as ThreadType,
    });
    const events: Array<{ threadId: ThreadId; text: string }> = [];
    core.on("setupResubmit", (threadId, text) => {
      events.push({ threadId, text });
    });

    await core.sendMessage([{ type: "user", text: "subagent task" }]);
    const stream = await mockClient.awaitStream();
    stream.respondWithError(new Error("subagent provider failure"));

    await pollUntil(() => {
      if (core.agent.getState().status.type === "error") return true;
      throw new Error("waiting for error state");
    });

    expect(events).toHaveLength(0);
    expect(core.state.failedSubmit).toBeUndefined();
    expect(core.getProviderMessages().length).toBe(1);
    expect(core.agent.getState().status.type).toBe("error");
  });

  it("captures preSubmitNativeIdx before appending the user message", async () => {
    const { core, mockClient } = createThreadCoreWithMock();

    expect(core.state.preSubmitNativeIdx).toBeUndefined();

    await core.sendMessage([{ type: "user", text: "first message" }]);
    expect(core.state.preSubmitNativeIdx).toBe(-1);

    const stream = await mockClient.awaitStream();
    stream.streamText("hi");
    stream.finishResponse("end_turn");

    await pollUntil(() => {
      const msgs = core.getProviderMessages();
      if (msgs.length === 2 && msgs[1].role === "assistant") return true;
      throw new Error("waiting for assistant message");
    });

    await core.sendMessage([{ type: "user", text: "second message" }]);
    expect(core.state.preSubmitNativeIdx).toBe(1);
  });

  it("rolls back queued pending-message text alongside the in-flight user message on error", async () => {
    const { core, mockClient } = createThreadCoreWithMock();

    await core.sendMessage([{ type: "user", text: "find the bug" }]);
    const stream = await mockClient.awaitStream();

    // While the agent is busy streaming, queue an additional async message —
    // this lands in pendingMessages rather than being sent immediately.
    await core.handleSendMessageRequest(
      [{ type: "user", text: "also check the logs" }],
      true,
    );
    expect(core.state.pendingMessages).toHaveLength(1);

    stream.respondWithError(new Error("provider failure"));

    await pollUntil(() => {
      if (core.agent.getState().status.type === "error") return true;
      throw new Error("waiting for error state");
    });

    expect(core.state.failedSubmit?.userMessage).toBe(
      "find the bug\nalso check the logs",
    );
    expect(core.state.pendingMessages).toEqual([]);
  });

  it("after non-retryable error, preSubmitNativeIdx remains set and orphan user message remains in history", async () => {
    const { core, mockClient } = createThreadCoreWithMock();

    await core.sendMessage([{ type: "user", text: "find the bug" }]);
    const stream = await mockClient.awaitStream();
    stream.respondWithError(new Error("provider failure"));

    await pollUntil(() => {
      if (core.agent.getState().status.type === "error") return true;
      throw new Error("waiting for error state");
    });

    expect(core.state.preSubmitNativeIdx).toBe(-1);
    expect(core.state.failedSubmit?.userMessage).toContain("find the bug");

    const messages = core.getProviderMessages();
    expect(messages.length).toBe(1);
    expect(messages[0].role).toBe("user");
  });

  it("discardFailedSubmit truncates agent history back to pre-submit and clears preSubmitNativeIdx but keeps failedSubmit", async () => {
    const { core, mockClient } = createThreadCoreWithMock();

    await core.sendMessage([{ type: "user", text: "find the bug" }]);
    const stream = await mockClient.awaitStream();
    stream.respondWithError(new Error("provider failure"));

    await pollUntil(() => {
      if (core.agent.getState().status.type === "error") return true;
      throw new Error("waiting for error state");
    });

    core.discardFailedSubmit();

    expect(core.getProviderMessages().length).toBe(0);
    expect(core.state.preSubmitNativeIdx).toBeUndefined();
    expect(core.state.failedSubmit?.userMessage).toContain("find the bug");
  });

  it("discardFailedSubmit is a no-op when preSubmitNativeIdx is undefined", () => {
    const { core } = createThreadCoreWithMock();
    expect(core.state.preSubmitNativeIdx).toBeUndefined();
    expect(core.getProviderMessages().length).toBe(0);
    core.discardFailedSubmit();
    expect(core.getProviderMessages().length).toBe(0);
    expect(core.state.preSubmitNativeIdx).toBeUndefined();
  });

  it("after error + discardFailedSubmit, resubmit does not duplicate the user message and resets state", async () => {
    const { core, mockClient } = createThreadCoreWithMock();

    await core.sendMessage([{ type: "user", text: "find the bug" }]);
    const firstStream = await mockClient.awaitStream();
    firstStream.respondWithError(new Error("provider failure"));

    await pollUntil(() => {
      if (core.agent.getState().status.type === "error") return true;
      throw new Error("waiting for error state");
    });

    expect(core.getProviderMessages().length).toBe(1);
    expect(core.state.preSubmitNativeIdx).toBe(-1);

    core.discardFailedSubmit();
    expect(core.getProviderMessages().length).toBe(0);
    expect(core.state.preSubmitNativeIdx).toBeUndefined();
    expect(core.state.failedSubmit?.userMessage).toContain("find the bug");

    await core.sendMessage([{ type: "user", text: "find the bug" }]);
    const secondStream = await pollUntil(() => {
      const s = mockClient.streams[mockClient.streams.length - 1];
      if (s && s !== firstStream) return s;
      throw new Error("waiting for resubmit stream");
    });

    const userMessages = core
      .getProviderMessages()
      .filter((m) => m.role === "user");
    expect(userMessages.length).toBe(1);
    expect(core.state.failedSubmit).toBeUndefined();
    expect(core.state.preSubmitNativeIdx).toBe(-1);

    secondStream.respond({
      text: "ok",
      toolRequests: [],
      stopReason: "end_turn",
    });
  });
});
describe("ThreadCore auto-resubmit for non-user-facing threads (Stage 2)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("subagent automatically resubmits a recoverable error and eventually yields", async () => {
    const { core, mockClient } = createThreadCoreWithMock({
      threadType: "subagent" as ThreadType,
    });
    const setupResubmitEvents: Array<{ threadId: ThreadId; text: string }> = [];
    core.on("setupResubmit", (threadId, text) => {
      setupResubmitEvents.push({ threadId, text });
    });

    await core.sendMessage([{ type: "user", text: "flaky task" }]);
    const firstStream = await mockClient.awaitStream();

    // Bypass the agent's own mid-stream retry budget so this error is
    // surfaced to ThreadCore immediately, as if the connection-level
    // retries had already been exhausted.
    vi.setSystemTime(new Date(Date.now() + 300_001));
    firstStream.respondWithError(new Error("terminated"));
    await vi.advanceTimersByTimeAsync(0);

    expect(core.agent.getState().status.type).toBe("error");
    expect(setupResubmitEvents).toHaveLength(0);
    expect(core.state.failedSubmit).toBeUndefined();

    // Advance past the first thread-level retry delay (1000ms).
    await vi.advanceTimersByTimeAsync(1000);

    const secondStream = await pollUntil(() => {
      const s = mockClient.streams[mockClient.streams.length - 1];
      if (s && s !== firstStream) return s;
      throw new Error("waiting for auto-resubmit stream");
    });

    secondStream.respond({
      text: "done",
      toolRequests: [],
      stopReason: "end_turn",
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(core.agent.getState().status.type).toBe("stopped");
    const userMessages = core
      .getProviderMessages()
      .filter((m) => m.role === "user");
    expect(userMessages.length).toBe(1);
    expect(setupResubmitEvents).toHaveLength(0);
  });

  it("subagent with a non-recoverable error stays parked and never auto-succeeds", async () => {
    const { core, mockClient } = createThreadCoreWithMock({
      threadType: "subagent" as ThreadType,
    });

    await core.sendMessage([{ type: "user", text: "doomed task" }]);
    const stream = await mockClient.awaitStream();
    stream.respondWithError(new Error("subagent provider failure"));
    await vi.advanceTimersByTimeAsync(0);

    expect(core.agent.getState().status.type).toBe("error");

    // Advance well past every retry delay; no retry should ever be scheduled.
    await vi.advanceTimersByTimeAsync(60_000);

    expect(mockClient.streams).toHaveLength(1);
    expect(core.agent.getState().status.type).toBe("error");
    expect(core.state.failedSubmit).toBeUndefined();
  });

  it("subagent stops auto-resubmitting once the retry budget is exhausted", async () => {
    const { core, mockClient } = createThreadCoreWithMock({
      threadType: "subagent" as ThreadType,
    });

    await core.sendMessage([{ type: "user", text: "flaky task" }]);
    let stream = await mockClient.awaitStream();

    // Bypass the agent's own mid-stream retry budget so each error is
    // surfaced to ThreadCore immediately.
    const bypassAgentRetryAndFail = () => {
      vi.setSystemTime(new Date(Date.now() + 300_001));
      stream.respondWithError(new Error("terminated"));
    };

    bypassAgentRetryAndFail();
    await vi.advanceTimersByTimeAsync(0);
    expect(core.agent.getState().status.type).toBe("error");

    let streamCountBefore = mockClient.streams.length;
    for (let i = 0; i < 20; i++) {
      // Advance past the largest possible thread-level retry delay so any
      // scheduled retry timer fires.
      await vi.advanceTimersByTimeAsync(40_000);
      if (mockClient.streams.length === streamCountBefore) {
        // No new stream was created: the retry budget has been exhausted.
        break;
      }
      stream = mockClient.streams[mockClient.streams.length - 1];
      streamCountBefore = mockClient.streams.length;
      bypassAgentRetryAndFail();
      await vi.advanceTimersByTimeAsync(0);
    }

    expect(core.agent.getState().status.type).toBe("error");
    const finalStreamCount = mockClient.streams.length;

    // No further retry should ever be scheduled.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mockClient.streams).toHaveLength(finalStreamCount);
    expect(core.agent.getState().status.type).toBe("error");
  });

  it("aborting a subagent cancels a pending auto-resubmit timer", async () => {
    const { core, mockClient } = createThreadCoreWithMock({
      threadType: "subagent" as ThreadType,
    });

    await core.sendMessage([{ type: "user", text: "flaky task" }]);
    const stream = await mockClient.awaitStream();

    // Bypass the agent's own mid-stream retry budget so this error is
    // surfaced to ThreadCore immediately, scheduling an auto-resubmit timer.
    vi.setSystemTime(new Date(Date.now() + 300_001));
    stream.respondWithError(new Error("terminated"));
    await vi.advanceTimersByTimeAsync(0);

    expect(core.agent.getState().status.type).toBe("error");
    expect(mockClient.streams).toHaveLength(1);

    // Abort before the scheduled retry (1000ms) fires.
    await core.abort();

    // Advance well past every retry delay; the cancelled retry must never fire.
    await vi.advanceTimersByTimeAsync(60_000);

    expect(mockClient.streams).toHaveLength(1);
  });

  it("does not schedule an auto-resubmit when there is no user message to roll back to", async () => {
    const { core, mockClient } = createThreadCoreWithMock({
      threadType: "subagent" as ThreadType,
    });

    // Directly exercise the private auto-resubmit path with an empty
    // userMessage — the case where an error occurs with no user-authored
    // text available to roll back to and resubmit (e.g. before any content
    // was ever produced). This is not reachable through the public
    // sendMessage API, since every InputMessage (user or system) produces a
    // plain "text" content block that would populate baseText.
    (
      core as unknown as {
        maybeAutoResubmitAfterError: (
          error: Error,
          userMessage: string,
        ) => void;
      }
    ).maybeAutoResubmitAfterError(new Error("terminated"), "");

    await vi.advanceTimersByTimeAsync(60_000);

    expect(mockClient.streams).toHaveLength(0);
    expect(core.state.failedSubmit).toBeUndefined();
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

async function cleanupArchive(threadId: ThreadId): Promise<void> {
  const dir = path.dirname(
    threadConversationLogPath(threadId, TEST_ARCHIVE_DIR),
  );
  await fs.rm(dir, { recursive: true, force: true });
}

function uniqueThreadId(prefix: string): ThreadId {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}` as ThreadId;
}

describe("ThreadCore conversation archive", () => {
  it("writes a normal turn's full messages (tool_use + tool_result) to the archive", async () => {
    const threadId = uniqueThreadId("archive-normal");
    const fileIO = new InMemoryFileIO({ "/tmp/a.txt": "hello" });
    const { core, mockClient } = createThreadCoreWithMock({ fileIO }, threadId);

    try {
      await core.sendMessage([{ type: "user", text: "edit a" }]);
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
        if (core.agent.getState().status.type !== "stopped")
          throw new Error("waiting");
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
    const { core, mockClient } = createThreadCoreWithMock({ fileIO }, threadId);

    try {
      await core.sendMessage([{ type: "user", text: "edit a" }]);
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
        if (core.agent.getState().status.type !== "stopped")
          throw new Error("waiting");
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
    const { core, mockClient } = createThreadCoreWithMock(undefined, threadId);

    try {
      await core.sendMessage([{ type: "user", text: "first turn" }]);
      const stream = await mockClient.awaitStream();
      stream.streamText("done");
      stream.finishResponse("end_turn");

      await pollUntil(() => {
        if (core.agent.getState().status.type !== "stopped")
          throw new Error("waiting");
        return true;
      });
      await core.awaitArchiveFlush();

      const compactPromise = (
        core as unknown as {
          handleCompactComplete: (
            summary: string,
            nextPrompt: string | undefined,
            steps: unknown[],
          ) => Promise<void>;
        }
      ).handleCompactComplete("SUMMARY TEXT", undefined, [{}, {}]);

      const contStream = await pollUntil(() => {
        if (mockClient.streams.length < 2) throw new Error("waiting");
        return mockClient.streams[1];
      });
      contStream.streamText("resumed");
      contStream.finishResponse("end_turn");
      await compactPromise;
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
    } = createThreadCoreWithMock(undefined, parentId);

    let child: ThreadCore | undefined;
    try {
      await parent.sendMessage([{ type: "user", text: "parent turn" }]);
      const stream = await mockClient.awaitStream();
      stream.streamText("parent response");
      stream.finishResponse("end_turn");

      await pollUntil(() => {
        if (parent.agent.getState().status.type !== "stopped")
          throw new Error("waiting");
        return true;
      });

      const nativeMessageIdx = parent.agent.getNativeMessageIdx();
      child = await ThreadCore.clone({
        sourceCore: parent,
        newId: childId,
        nativeMessageIdx,
        context,
      });

      await child.sendMessage([{ type: "user", text: "child turn" }]);
      const childStream = await pollUntil(() => {
        const s = mockClient.streams[mockClient.streams.length - 1];
        if (!s || s === stream) throw new Error("waiting");
        return s;
      });
      childStream.streamText("child response");
      childStream.finishResponse("end_turn");

      await pollUntil(() => {
        if (child!.agent.getState().status.type !== "stopped")
          throw new Error("waiting");
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

describe("ThreadCore scratchpad state", () => {
  it("subagent threads start with an empty scratchpad", () => {
    const { core } = createThreadCoreWithMock({
      threadType: "subagent" as ThreadType,
    });
    expect(core.state.scratchpad.entries).toEqual([]);
  });

  it("empties a populated scratchpad on reset-after-compaction", () => {
    const { core } = createThreadCoreWithMock();
    core.state.scratchpad.entries.push({ key: "a", value: "1" });
    core.state.scratchpad.entries.push({ key: "b", value: "2" });
    core.update({ type: "reset-after-compaction" });
    expect(core.state.scratchpad.entries).toEqual([]);
  });

  it("clone deep-copies scratchpad and edlRegisters with isolation", async () => {
    const parentId = uniqueThreadId("sp-parent");
    const childId = uniqueThreadId("sp-child");
    const {
      core: parent,
      mockClient,
      context,
    } = createThreadCoreWithMock(undefined, parentId);

    let child: ThreadCore | undefined;
    try {
      await parent.sendMessage([{ type: "user", text: "parent turn" }]);
      const stream = await mockClient.awaitStream();
      stream.streamText("parent response");
      stream.finishResponse("end_turn");
      await pollUntil(() => {
        if (parent.agent.getState().status.type !== "stopped")
          throw new Error("waiting");
        return true;
      });

      parent.state.scratchpad.entries.push({ key: "a", value: "1" });
      parent.state.edlRegisters.registers.set("r", "regval");
      parent.state.edlRegisters.nextSavedId = 3;

      const nativeMessageIdx = parent.agent.getNativeMessageIdx();
      child = await ThreadCore.clone({
        sourceCore: parent,
        newId: childId,
        nativeMessageIdx,
        context,
      });

      expect(child.state.scratchpad.entries).toEqual([
        { key: "a", value: "1" },
      ]);
      expect(child.state.edlRegisters.registers.get("r")).toBe("regval");
      expect(child.state.edlRegisters.nextSavedId).toBe(3);

      child.state.scratchpad.entries.push({ key: "b", value: "2" });
      child.state.edlRegisters.registers.set("r2", "x");
      expect(parent.state.scratchpad.entries.map((e) => e.key)).toEqual(["a"]);
      expect(parent.state.edlRegisters.registers.has("r2")).toBe(false);
    } finally {
      await parent.destroy();
      if (child) await child.destroy();
      await cleanupArchive(parentId);
      await cleanupArchive(childId);
    }
  });
});
