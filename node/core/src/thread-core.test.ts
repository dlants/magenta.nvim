import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
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
import { SubagentSupervisor } from "./thread-supervisor.ts";
import type { ToolName, ToolRequestId } from "./tool-types.ts";
import { validateInput } from "./tools/helpers.ts";
import type { MCPToolManager } from "./tools/mcp/manager.ts";
import { pollUntil } from "./utils/async.ts";

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

function createThreadCoreWithMock(overrides?: Partial<ThreadCoreContext>): {
  core: ThreadCore;
  mockClient: MockAnthropicClient;
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
    lspClient: {} as unknown as ThreadCoreContext["lspClient"],
    diagnosticsProvider: {
      getDiagnostics: async () => [],
    } as unknown as ThreadCoreContext["diagnosticsProvider"],
    helpTagsProvider: {
      listTagFiles: async () => [],
    } as unknown as ThreadCoreContext["helpTagsProvider"],
    availableCapabilities: new Set(),
    environmentConfig: { type: "local" },
    maxConcurrentSubagents: 1,
    getAgents: () => ({}),
    getProvider: () => provider,
    ...overrides,
  };

  return {
    core: new ThreadCore("test-thread" as ThreadId, context),
    mockClient,
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

describe("SubagentSupervisor yield tag detection", () => {
  it("nudges agent when it writes a <yield_to_parent> XML tag instead of calling the tool", async () => {
    const { core, mockClient } = createThreadCoreWithMock({
      threadType: "subagent" as ThreadType,
    });
    core.supervisor = new SubagentSupervisor();

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
    core.supervisor = new SubagentSupervisor();

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
    expect(core.state.editedFilesThisTurn).toEqual(["/tmp/a.txt"]);

    await core.sendMessage([{ type: "user", text: "next turn" }]);
    expect(core.state.editedFilesThisTurn).toEqual([]);
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

function makeShortShellResult(): ShellResult {
  return {
    exitCode: 0,
    signal: undefined,
    output: [{ stream: "stdout", text: "ok" }],
    logFilePath: "/tmp/test.log",
    durationMs: 10,
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
