import type Anthropic from "@anthropic-ai/sdk";
import type { ToolName, ToolRequestId } from "@magenta/core";
import { validateInput, PLACEHOLDER_NATIVE_MESSAGE_IDX } from "@magenta/core";
import { describe, expect, it } from "vitest";
import winston from "winston";
import { delay } from "../utils/async.ts";
import {
  AnthropicAgent,
  type AnthropicAgentOptions,
} from "./anthropic-agent.ts";
import { MockAnthropicClient } from "./mock-anthropic-client.ts";
import type {
  AgentInput,
  AgentMsg,
  ProviderToolResult,
  ProviderToolSpec,
} from "./provider-types.ts";

type TrackedMessages = {
  messages: AgentMsg[];
};

function createAgent(
  mockClient: MockAnthropicClient | Anthropic,
  options?: Partial<typeof defaultOptions> & {
    thinking?: {
      enabled: boolean;
      budgetTokens?: number;
      displayThinking?: boolean;
      effort?: "low" | "medium" | "high" | "xhigh" | "max";
    };
  },
  tracked?: TrackedMessages,
): AnthropicAgent {
  const agent = new AnthropicAgent(
    { ...defaultOptions, ...options },
    mockClient as unknown as Anthropic,
    defaultAnthropicOptions,
  );
  if (tracked) {
    agent.on("didUpdate", () => {
      tracked.messages.push({ type: "agent-content-updated" });
    });
    agent.on("stopped", (stopReason, usage) => {
      tracked.messages.push({
        type: "agent-stopped",
        stopReason,
        ...(usage && { usage }),
      });
    });
    agent.on("error", (error) => {
      tracked.messages.push({ type: "agent-error", error });
    });
  }
  return agent;
}

function trackMessages(): TrackedMessages {
  return { messages: [] };
}

const defaultOptions = {
  model: "claude-sonnet-4-20250514",
  systemPrompt: "You are a helpful assistant.",
  tools: [] as ProviderToolSpec[],
};

const defaultAnthropicOptions: AnthropicAgentOptions = {
  authType: "max",
  includeWebSearch: true,
  disableParallelToolUseFlag: true,
  logger: winston.createLogger(),
  validateInput,
};

describe("thinking.effort", () => {
  it("includes output_config.effort on adaptive-thinking models", async () => {
    const mockClient = new MockAnthropicClient();
    const agent = createAgent(mockClient, {
      model: "claude-opus-4-7",
      thinking: { enabled: true, effort: "max" },
    });

    agent.appendUserMessage([{ type: "text", text: "Hi", nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX }]);
    await delay(0);
    agent.continueConversation();

    const stream = await mockClient.awaitStream();

    expect(stream.params.output_config?.effort).toBe("max");
    expect(stream.params.thinking).toEqual({
      type: "adaptive",
      display: "omitted",
    });

    stream.finishResponse("end_turn");
    await stream.finalMessage();
  });

  it("drops effort and warns on non-adaptive-thinking models", async () => {
    const mockClient = new MockAnthropicClient();
    const warnings: string[] = [];
    const logger = winston.createLogger();
    logger.warn = ((msg: string) => {
      warnings.push(msg);
      return logger;
    }) as typeof logger.warn;

    const agent = new AnthropicAgent(
      {
        model: "claude-sonnet-4-5",
        systemPrompt: "You are a helpful assistant.",
        tools: [] as ProviderToolSpec[],
        thinking: { enabled: true, effort: "max" },
      },
      mockClient as unknown as Anthropic,
      { ...defaultAnthropicOptions, logger },
    );

    agent.appendUserMessage([{ type: "text", text: "Hi", nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX }]);
    await delay(0);
    agent.continueConversation();

    const stream = await mockClient.awaitStream();

    expect(stream.params.output_config).toBeUndefined();
    expect(
      warnings.some((w) => w.includes("thinking.effort is only supported")),
    ).toBe(true);

    stream.finishResponse("end_turn");
    await stream.finalMessage();
  });
});

describe("appendUserMessage", () => {
  it("does not add assistant message until first content block completes", async () => {
    const mockClient = new MockAnthropicClient();
    const agent = createAgent(mockClient);

    agent.appendUserMessage([{ type: "text", text: "Hello", nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX }]);
    await delay(0);
    agent.continueConversation();

    const stream = await mockClient.awaitStream();

    // Before any content blocks, should only have user message
    expect(agent.getState().messages).toHaveLength(1);
    expect(agent.getState().messages[0].role).toBe("user");

    // Start a text block
    const blockIndex = stream.nextBlockIndex();
    stream.emitEvent({
      type: "content_block_start",
      index: blockIndex,
      content_block: { type: "text", text: "", citations: null },
    });
    await stream.settle();

    // Still only user message - assistant message not added yet
    expect(agent.getState().messages).toHaveLength(1);

    // Add some text delta
    stream.emitEvent({
      type: "content_block_delta",
      index: blockIndex,
      delta: { type: "text_delta", text: "Hello world" },
    });
    await stream.settle();

    // Still only user message
    expect(agent.getState().messages).toHaveLength(1);

    // Complete the block
    stream.emitEvent({
      type: "content_block_stop",
      index: blockIndex,
    });
    await stream.settle();

    // Now assistant message should be added
    expect(agent.getState().messages).toHaveLength(2);
    expect(agent.getState().messages[1].role).toBe("assistant");
    expect(agent.getState().messages[1].content).toHaveLength(1);

    stream.finishResponse("end_turn");
    await stream.finalMessage();
  });

  it("appends text message and dispatches content-updated async", async () => {
    const mockClient = {} as Anthropic;
    const tracked = trackMessages();
    const agent = createAgent(mockClient, undefined, tracked);

    const content: AgentInput[] = [{ type: "text", text: "Hello, world!", nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX }];
    agent.appendUserMessage(content);

    // Message should not have been dispatched synchronously
    expect(tracked.messages).toHaveLength(0);

    const state = agent.getState();
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].role).toBe("user");
    expect(state.messages[0].content).toHaveLength(1);
    expect(state.messages[0].content[0]).toMatchObject({
      type: "text",
      text: "Hello, world!",
    });

    // Message dispatched asynchronously
    await delay(0);
    expect(tracked.messages).toHaveLength(1);
    expect(tracked.messages[0].type).toBe("agent-content-updated");
  });

  it("appends image message correctly", () => {
    const mockClient = {} as Anthropic;
    const agent = createAgent(mockClient);

    const content: AgentInput[] = [
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: "base64data",
        },
        nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
      },
    ];
    agent.appendUserMessage(content);

    const state = agent.getState();
    expect(state.messages[0].content[0]).toMatchObject({
      type: "image",
      source: {
        type: "base64",
        media_type: "image/png",
        data: "base64data",
      },
    });
  });

  it("appends document message correctly", () => {
    const mockClient = {} as Anthropic;
    const agent = createAgent(mockClient);

    const content: AgentInput[] = [
      {
        type: "document",
        source: {
          type: "base64",
          media_type: "application/pdf",
          data: "pdfdata",
        },
        title: "My Document",
        nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
      },
    ];
    agent.appendUserMessage(content);

    const state = agent.getState();
    expect(state.messages[0].content[0]).toMatchObject({
      type: "document",
      source: {
        type: "base64",
        media_type: "application/pdf",
        data: "pdfdata",
      },
      title: "My Document",
    });
  });
});

describe("toolResult", () => {
  it("throws when not in stopped state with tool_use reason", () => {
    const mockClient = {} as Anthropic;
    const agent = createAgent(mockClient);

    const toolUseId = "tool-123" as ToolRequestId;
    const result: ProviderToolResult = {
      type: "tool_result",
      id: toolUseId,
      result: {
        status: "ok",
        value: [{ type: "text", text: "Tool output", nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX }],
        structuredResult: { toolName: "get_file" as ToolName },
      },
      nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
    };

    expect(() => agent.toolResult(toolUseId, result)).toThrow(
      "Cannot provide tool result: expected status stopped",
    );
  });

  it("appends tool result when in correct state", async () => {
    const mockClient = new MockAnthropicClient();
    const agent = createAgent(mockClient);

    const toolUseId = "tool-123" as ToolRequestId;

    // Send a message to trigger streaming, then respond with tool_use
    agent.appendUserMessage([{ type: "text", text: "Hello", nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX }]);
    await delay(0);
    agent.continueConversation();

    const stream = await mockClient.awaitStream();
    stream.streamToolUse(toolUseId, "get_file" as ToolName, {
      filePath: "test.ts",
    });
    stream.finishResponse("tool_use");

    // Wait for the stream to complete
    await stream.finalMessage();
    // Give time for the promise handler to run
    await new Promise((resolve) => setTimeout(resolve, 0));

    const result: ProviderToolResult = {
      type: "tool_result",
      id: toolUseId,
      result: {
        status: "ok",
        value: [{ type: "text", text: "Tool output", nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX }],
        structuredResult: { toolName: "get_file" as ToolName },
      },
      nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
    };

    agent.toolResult(toolUseId, result);

    const state = agent.getState();
    expect(state.messages).toHaveLength(3);
    expect(state.messages[2].role).toBe("user");

    const toolResult = state.messages[2].content[0];
    expect(toolResult.type).toBe("tool_result");
  });
});

describe("continueConversation", () => {
  it("succeeds when last message is from user", () => {
    const mockClient = new MockAnthropicClient();
    const agent = createAgent(mockClient);

    agent.appendUserMessage([{ type: "text", text: "Hello", nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX }]);

    // Should not throw
    expect(() => agent.continueConversation()).not.toThrow();
  });
});

describe("dispatch messages", () => {
  it("dispatches messages when stream updates state", async () => {
    const mockClient = new MockAnthropicClient();
    const tracked = trackMessages();
    const agent = createAgent(mockClient, undefined, tracked);

    // appendUserMessage dispatches content-updated async
    agent.appendUserMessage([{ type: "text", text: "Test", nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX }]);
    expect(tracked.messages).toHaveLength(0);
    await delay(0);
    expect(tracked.messages).toHaveLength(1);

    // continueConversation triggers streaming which dispatches messages
    agent.continueConversation();
    await delay(0);

    const stream = await mockClient.awaitStream();
    stream.streamText("Hello");
    await delay(0);
    // Should have content-updated messages from streaming
    expect(
      tracked.messages.filter((m) => m.type === "agent-content-updated").length,
    ).toBeGreaterThan(1);
    stream.finishResponse("end_turn");

    await stream.finalMessage();
    await delay(0);

    // Should have agent-stopped message
    expect(tracked.messages.some((m) => m.type === "agent-stopped")).toBe(true);
  });
});

describe("abort", () => {
  it("does nothing when no active request", async () => {
    const mockClient = {} as Anthropic;
    const tracked = trackMessages();
    const agent = createAgent(mockClient, undefined, tracked);

    await agent.abort();
    await delay(0);

    expect(tracked.messages).toHaveLength(0);
    expect(agent.getState().status).toEqual({
      type: "stopped",
      stopReason: "end_turn",
    });
  });

  it("sets stopped status with aborted reason when stream is active", async () => {
    const mockClient = new MockAnthropicClient();
    const tracked = trackMessages();
    const agent = createAgent(mockClient, undefined, tracked);

    agent.appendUserMessage([{ type: "text", text: "Hello", nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX }]);
    await delay(0);
    agent.continueConversation();

    const stream = await mockClient.awaitStream();

    // Start streaming some text
    stream.streamText("Partial response");

    // Abort the request
    await agent.abort();

    // Wait for the catch block to execute
    await delay(0);

    const state = agent.getState();
    expect(state.status).toEqual({
      type: "stopped",
      stopReason: "aborted",
    });

    expect(
      tracked.messages.some(
        (m) => m.type === "agent-stopped" && m.stopReason === "aborted",
      ),
    ).toBe(true);
  });

  it("adds tool_result with abort message when aborting during tool_use", async () => {
    const mockClient = new MockAnthropicClient();
    const agent = createAgent(mockClient);

    agent.appendUserMessage([{ type: "text", text: "Hello", nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX }]);
    await delay(0);
    agent.continueConversation();

    const stream = await mockClient.awaitStream();

    // Stream a tool_use block but don't finish the response
    const toolUseId = "tool-abort-test" as ToolRequestId;
    stream.streamToolUse(toolUseId, "get_file" as ToolName, {
      filePath: "test.ts",
    });

    // Abort while tool_use is the last block
    await agent.abort();

    await new Promise((resolve) => setTimeout(resolve, 0));

    const state = agent.getState();

    // Should have: user message, assistant with tool_use, user with tool_result
    expect(state.messages).toHaveLength(3);
    expect(state.messages[2].role).toBe("user");

    const toolResult = state.messages[2].content[0];
    expect(toolResult.type).toBe("tool_result");
    if (toolResult.type === "tool_result") {
      expect(toolResult.id).toBe(toolUseId);
      expect(toolResult.result.status).toBe("error");
      if (toolResult.result.status === "error") {
        expect(toolResult.result.error).toContain("aborted");
      }
    }
  });

  it("removes server_tool_use block when aborting during web search", async () => {
    const mockClient = new MockAnthropicClient();
    const agent = createAgent(mockClient);

    agent.appendUserMessage([{ type: "text", text: "Search for info", nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX }]);
    await delay(0);
    agent.continueConversation();

    const stream = await mockClient.awaitStream();

    // Stream some text first
    stream.streamText("Let me search for that.");

    // Stream a server_tool_use block (web search)
    stream.streamServerToolUse("server-tool-1", "web_search", {
      query: "test query",
    });

    // Abort while waiting for web search results
    await agent.abort();

    await new Promise((resolve) => setTimeout(resolve, 0));

    const state = agent.getState();

    // Should have: user message, assistant with just text (server_tool_use removed)
    expect(state.messages).toHaveLength(2);
    expect(state.messages[1].role).toBe("assistant");
    expect(state.messages[1].content).toHaveLength(1);
    expect(state.messages[1].content[0].type).toBe("text");
  });
});

describe("abort with empty blocks", () => {
  it("removes empty text block when aborting before any text deltas", async () => {
    const mockClient = new MockAnthropicClient();
    const agent = createAgent(mockClient);

    agent.appendUserMessage([{ type: "text", text: "Hello", nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX }]);
    await delay(0);
    agent.continueConversation();

    const stream = await mockClient.awaitStream();

    // Start a text block but don't send any deltas
    const blockIndex = stream.nextBlockIndex();
    stream.emitEvent({
      type: "content_block_start",
      index: blockIndex,
      content_block: { type: "text", text: "", citations: null },
    });

    // Block finishes with empty text (can happen during abort)
    stream.emitEvent({
      type: "content_block_stop",
      index: blockIndex,
    });

    // Abort
    await agent.abort();
    await delay(0);

    const state = agent.getState();
    // The empty text block should be filtered out, leaving only the user message
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].role).toBe("user");
  });

  it("removes empty thinking block when aborting before any thinking deltas", async () => {
    const mockClient = new MockAnthropicClient();
    const agent = createAgent(mockClient);

    agent.appendUserMessage([{ type: "text", text: "Hello", nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX }]);
    await delay(0);
    agent.continueConversation();

    const stream = await mockClient.awaitStream();

    // Start a thinking block but don't send any deltas
    const blockIndex = stream.nextBlockIndex();
    stream.emitEvent({
      type: "content_block_start",
      index: blockIndex,
      content_block: { type: "thinking", thinking: "", signature: "" },
    });

    stream.emitEvent({
      type: "content_block_stop",
      index: blockIndex,
    });

    await agent.abort();
    await delay(0);

    const state = agent.getState();
    // The empty thinking block should be filtered out
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].role).toBe("user");
  });

  it("keeps non-empty blocks and removes empty ones when aborting", async () => {
    const mockClient = new MockAnthropicClient();
    const agent = createAgent(mockClient);

    agent.appendUserMessage([{ type: "text", text: "Hello", nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX }]);
    await delay(0);
    agent.continueConversation();

    const stream = await mockClient.awaitStream();

    // Stream a thinking block with content
    stream.streamThinking("Some thoughts", "sig123");

    // Start a text block but don't send any deltas (empty)
    const blockIndex = stream.nextBlockIndex();
    stream.emitEvent({
      type: "content_block_start",
      index: blockIndex,
      content_block: { type: "text", text: "", citations: null },
    });
    stream.emitEvent({
      type: "content_block_stop",
      index: blockIndex,
    });

    await agent.abort();
    await delay(0);

    const state = agent.getState();
    // Should keep the thinking block but remove the empty text block
    expect(state.messages).toHaveLength(2);
    expect(state.messages[1].role).toBe("assistant");
    expect(state.messages[1].content).toHaveLength(1);
    expect(state.messages[1].content[0].type).toBe("thinking");
  });
});

describe("thinking blocks", () => {
  it("captures thinking content and signature during streaming", async () => {
    const mockClient = new MockAnthropicClient();
    const agent = createAgent(mockClient);

    agent.appendUserMessage([{ type: "text", text: "Hello", nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX }]);
    await delay(0);
    agent.continueConversation();

    const stream = await mockClient.awaitStream();

    const blockIndex = stream.nextBlockIndex();

    // Start thinking block
    stream.emitEvent({
      type: "content_block_start",
      index: blockIndex,
      content_block: { type: "thinking", thinking: "", signature: "" },
    });
    await stream.settle();

    // Check streaming block is exposed
    let streamingBlock = agent.getStreamingBlock();
    expect(streamingBlock).toBeDefined();
    expect(streamingBlock?.type).toBe("thinking");

    // Add thinking content
    stream.emitEvent({
      type: "content_block_delta",
      index: blockIndex,
      delta: { type: "thinking_delta", thinking: "Let me think about this..." },
    });
    await stream.settle();

    streamingBlock = agent.getStreamingBlock();
    expect(streamingBlock?.type).toBe("thinking");
    if (streamingBlock?.type === "thinking") {
      expect(streamingBlock.thinking).toBe("Let me think about this...");
      expect(streamingBlock.signature).toBe("");
    }

    // Add signature
    stream.emitEvent({
      type: "content_block_delta",
      index: blockIndex,
      delta: {
        type: "signature_delta",
        signature: "EqQBCgIYAhIM1gbcDa9GJwZA2b3h",
      } as Anthropic.Messages.ContentBlockDeltaEvent["delta"],
    });
    await stream.settle();

    streamingBlock = agent.getStreamingBlock();
    if (streamingBlock?.type === "thinking") {
      expect(streamingBlock.thinking).toBe("Let me think about this...");
      expect(streamingBlock.signature).toBe("EqQBCgIYAhIM1gbcDa9GJwZA2b3h");
    }

    // Stop the block
    stream.emitEvent({
      type: "content_block_stop",
      index: blockIndex,
    });
    await stream.settle();

    expect(agent.getStreamingBlock()).toBeUndefined();

    // Check that the streamed content was captured in the message
    const state = agent.getState();
    expect(state.messages).toHaveLength(2);
    const assistantContent = state.messages[1].content;
    expect(assistantContent[0].type).toBe("thinking");
    if (assistantContent[0].type === "thinking") {
      expect(assistantContent[0].thinking).toBe("Let me think about this...");
      expect(assistantContent[0].signature).toBe(
        "EqQBCgIYAhIM1gbcDa9GJwZA2b3h",
      );
    }

    // Abort to clean up (since we manually streamed, finishResponse would replace content)
    await agent.abort();
  });

  it("accumulates signature across multiple deltas", async () => {
    const mockClient = new MockAnthropicClient();
    const agent = createAgent(mockClient);

    agent.appendUserMessage([{ type: "text", text: "Hello", nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX }]);
    await delay(0);
    agent.continueConversation();

    const stream = await mockClient.awaitStream();

    const blockIndex = stream.nextBlockIndex();

    stream.emitEvent({
      type: "content_block_start",
      index: blockIndex,
      content_block: { type: "thinking", thinking: "", signature: "" },
    });

    stream.emitEvent({
      type: "content_block_delta",
      index: blockIndex,
      delta: { type: "thinking_delta", thinking: "Part 1" },
    });

    stream.emitEvent({
      type: "content_block_delta",
      index: blockIndex,
      delta: { type: "thinking_delta", thinking: " Part 2" },
    });

    // Signature in multiple chunks
    stream.emitEvent({
      type: "content_block_delta",
      index: blockIndex,
      delta: {
        type: "signature_delta",
        signature: "ABC",
      } as Anthropic.Messages.ContentBlockDeltaEvent["delta"],
    });

    stream.emitEvent({
      type: "content_block_delta",
      index: blockIndex,
      delta: {
        type: "signature_delta",
        signature: "DEF",
      } as Anthropic.Messages.ContentBlockDeltaEvent["delta"],
    });

    const streamingBlock = agent.getStreamingBlock();
    if (streamingBlock?.type === "thinking") {
      expect(streamingBlock.thinking).toBe("Part 1 Part 2");
      expect(streamingBlock.signature).toBe("ABCDEF");
    }

    stream.emitEvent({
      type: "content_block_stop",
      index: blockIndex,
    });

    stream.finishResponse("end_turn");
    await stream.finalMessage();
  });

  it("uses streamThinking helper with signature", async () => {
    const mockClient = new MockAnthropicClient();
    const agent = createAgent(mockClient);

    agent.appendUserMessage([{ type: "text", text: "Hello", nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX }]);
    await delay(0);
    agent.continueConversation();

    const stream = await mockClient.awaitStream();
    stream.streamThinking("Deep thoughts here", "signature123");
    stream.streamText("Here is my answer");
    stream.finishResponse("end_turn");

    await stream.finalMessage();
    await delay(0);

    const state = agent.getState();
    expect(state.messages).toHaveLength(2);

    const assistantContent = state.messages[1].content;
    expect(assistantContent).toHaveLength(2);

    expect(assistantContent[0].type).toBe("thinking");
    if (assistantContent[0].type === "thinking") {
      expect(assistantContent[0].thinking).toBe("Deep thoughts here");
      expect(assistantContent[0].signature).toBe("signature123");
    }

    expect(assistantContent[1].type).toBe("text");
  });
});

describe("streaming block", () => {
  it("exposes text streaming block during streaming", async () => {
    const mockClient = new MockAnthropicClient();
    const agent = createAgent(mockClient);

    agent.appendUserMessage([{ type: "text", text: "Hello", nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX }]);
    await delay(0);
    agent.continueConversation();

    const stream = await mockClient.awaitStream();

    // Start a text block
    const blockIndex = stream.nextBlockIndex();
    stream.emitEvent({
      type: "content_block_start",
      index: blockIndex,
      content_block: { type: "text", text: "", citations: null },
    });
    await stream.settle();

    // Check streaming block is exposed
    let streamingBlock = agent.getStreamingBlock();
    expect(streamingBlock).toBeDefined();
    expect(streamingBlock?.type).toBe("text");

    // Add some text
    stream.emitEvent({
      type: "content_block_delta",
      index: blockIndex,
      delta: { type: "text_delta", text: "Hello world" },
    });
    await stream.settle();

    streamingBlock = agent.getStreamingBlock();
    expect(streamingBlock?.type).toBe("text");
    if (streamingBlock?.type === "text") {
      expect(streamingBlock.text).toBe("Hello world");
    }

    // Stop the block
    stream.emitEvent({
      type: "content_block_stop",
      index: blockIndex,
    });
    await stream.settle();

    // Streaming block should be cleared
    expect(agent.getStreamingBlock()).toBeUndefined();

    // Clean up
    stream.finishResponse("end_turn");
    await stream.finalMessage();
  });

  it("exposes tool_use streaming block during streaming", async () => {
    const mockClient = new MockAnthropicClient();
    const agent = createAgent(mockClient);

    agent.appendUserMessage([{ type: "text", text: "Hello", nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX }]);
    await delay(0);
    agent.continueConversation();

    const stream = await mockClient.awaitStream();

    const toolUseId = "tool-stream-test" as ToolRequestId;
    const blockIndex = stream.nextBlockIndex();

    // Start a tool_use block
    stream.emitEvent({
      type: "content_block_start",
      index: blockIndex,
      content_block: {
        type: "tool_use",
        id: toolUseId,
        name: "get_file",
        input: {},
        caller: { type: "direct" as const },
      },
    });
    await stream.settle();

    let streamingBlock = agent.getStreamingBlock();
    expect(streamingBlock?.type).toBe("tool_use");

    // Add input JSON
    stream.emitEvent({
      type: "content_block_delta",
      index: blockIndex,
      delta: { type: "input_json_delta", partial_json: '{"filePath":' },
    });

    stream.emitEvent({
      type: "content_block_delta",
      index: blockIndex,
      delta: { type: "input_json_delta", partial_json: '"test.ts"}' },
    });
    await stream.settle();

    streamingBlock = agent.getStreamingBlock();
    if (streamingBlock?.type === "tool_use") {
      expect(streamingBlock.inputJson).toBe('{"filePath":"test.ts"}');
    }

    // Stop the block
    stream.emitEvent({
      type: "content_block_stop",
      index: blockIndex,
    });
    await stream.settle();

    expect(agent.getStreamingBlock()).toBeUndefined();

    stream.finishResponse("tool_use");
    await stream.finalMessage();
  });

  it("returns undefined for server_tool_use blocks", async () => {
    const mockClient = new MockAnthropicClient();
    const agent = createAgent(mockClient);

    agent.appendUserMessage([{ type: "text", text: "Search", nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX }]);
    await delay(0);
    agent.continueConversation();

    const stream = await mockClient.awaitStream();

    const blockIndex = stream.nextBlockIndex();

    // Start a server_tool_use block
    stream.emitEvent({
      type: "content_block_start",
      index: blockIndex,
      content_block: {
        type: "server_tool_use",
        id: "server-tool-1",
        name: "web_search",
        input: {},
      } as unknown as Anthropic.Messages.ContentBlock,
    });

    // server_tool_use should not be exposed via getStreamingBlock
    expect(agent.getStreamingBlock()).toBeUndefined();

    stream.emitEvent({
      type: "content_block_stop",
      index: blockIndex,
    });

    stream.finishResponse("end_turn");
    await stream.finalMessage();
  });

  it("dispatches content-updated messages during streaming", async () => {
    const mockClient = new MockAnthropicClient();
    const tracked = trackMessages();
    const agent = createAgent(mockClient, undefined, tracked);

    agent.appendUserMessage([{ type: "text", text: "Hello", nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX }]);
    await delay(0);
    agent.continueConversation();

    const stream = await mockClient.awaitStream();

    // Count messages after initial events
    await delay(0);
    const initialCount = tracked.messages.length;

    stream.streamText("Hello world");
    await delay(0);

    // Should have dispatched content-updated messages for streaming
    expect(tracked.messages.length).toBeGreaterThan(initialCount);
    expect(
      tracked.messages
        .slice(initialCount)
        .some((m) => m.type === "agent-content-updated"),
    ).toBe(true);

    stream.finishResponse("end_turn");
    await stream.finalMessage();
  });
});

describe("web search result preservation", () => {
  it("preserves encrypted_content in web_search_tool_result after stream completes", async () => {
    const mockClient = new MockAnthropicClient();
    const agent = createAgent(mockClient);

    agent.appendUserMessage([
      { type: "text", text: "Search for Claude Shannon", nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX },
    ]);
    await delay(0);
    agent.continueConversation();

    const stream = await mockClient.awaitStream();

    // Stream: server_tool_use -> web_search_tool_result -> text with citations
    stream.streamServerToolUse("srvtoolu_abc123", "web_search", {
      query: "Claude Shannon biography",
    });

    const webSearchContent = [
      {
        type: "web_search_result",
        url: "https://en.wikipedia.org/wiki/Claude_Shannon",
        title: "Claude Shannon - Wikipedia",
        encrypted_content:
          "EqgfCioIARgBIiQ3YTAwMjY1Mi1mZjM5LTQ1NGUtODgxNC1kNjNjNTk1ZWI3Y...",
        page_age: "April 30, 2025",
      },
      {
        type: "web_search_result",
        url: "https://example.com/shannon",
        title: "Shannon Info Theory",
        encrypted_content: "RmFrZUVuY3J5cHRlZENvbnRlbnQ...",
        page_age: "May 1, 2025",
      },
    ];

    stream.streamWebSearchToolResult("srvtoolu_abc123", webSearchContent);

    stream.streamText(
      "Claude Shannon was born on April 30, 1916, in Petoskey, Michigan.",
    );

    stream.finishResponse("end_turn", {
      inputTokens: 100,
      outputTokens: 200,
      cacheHits: 0,
      cacheMisses: 6000,
    });

    await stream.finalMessage();
    await delay(0);

    const state = agent.getState();
    expect(state.messages).toHaveLength(2);

    const assistantContent = state.messages[1].content;
    expect(assistantContent).toHaveLength(3);

    // server_tool_use block
    expect(assistantContent[0].type).toBe("server_tool_use");

    // web_search_tool_result block with encrypted_content preserved
    expect(assistantContent[1].type).toBe("web_search_tool_result");
    if (assistantContent[1].type === "web_search_tool_result") {
      expect(assistantContent[1].content).toHaveLength(2);
      expect((assistantContent[1].content as unknown[])[0]).toHaveProperty(
        "encrypted_content",
        "EqgfCioIARgBIiQ3YTAwMjY1Mi1mZjM5LTQ1NGUtODgxNC1kNjNjNTk1ZWI3Y...",
      );
      expect((assistantContent[1].content as unknown[])[1]).toHaveProperty(
        "encrypted_content",
        "RmFrZUVuY3J5cHRlZENvbnRlbnQ...",
      );
    }

    // text block
    expect(assistantContent[2].type).toBe("text");
  });

  it("preserves web_search_tool_result in native messages for next turn", async () => {
    const mockClient = new MockAnthropicClient();
    const agent = createAgent(mockClient);

    agent.appendUserMessage([{ type: "text", text: "Search for info", nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX }]);
    await delay(0);
    agent.continueConversation();

    const stream = await mockClient.awaitStream();

    const webSearchContent = [
      {
        type: "web_search_result",
        url: "https://example.com",
        title: "Example",
        encrypted_content: "SomeEncryptedData...",
      },
    ];

    stream.streamServerToolUse("srvtoolu_001", "web_search", {
      query: "test",
    });
    stream.streamWebSearchToolResult("srvtoolu_001", webSearchContent);
    stream.streamText("Here are the results.");
    stream.finishResponse("end_turn");

    await stream.finalMessage();
    await delay(0);

    // Append a follow-up user message
    agent.appendUserMessage([{ type: "text", text: "Tell me more", nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX }]);
    await delay(0);
    agent.continueConversation();

    // Check that the native messages sent to the API contain the web search result
    const stream2 = await mockClient.awaitStream();
    const sentMessages = stream2.messages;

    // Messages: user, assistant (with server_tool_use + web_search_tool_result + text), user
    expect(sentMessages).toHaveLength(3);

    const assistantMsg = sentMessages[1];
    expect(assistantMsg.role).toBe("assistant");
    const blocks = assistantMsg.content as unknown as Record<string, unknown>[];

    const webResultBlock = blocks.find(
      (b) => b.type === "web_search_tool_result",
    );
    expect(webResultBlock).toBeDefined();
    expect(
      (webResultBlock!.content as Record<string, unknown>[])[0],
    ).toHaveProperty("encrypted_content", "SomeEncryptedData...");

    // Clean up
    stream2.streamText("More details.");
    stream2.finishResponse("end_turn");
    await stream2.finalMessage();
  });

  describe("error handling with cleanup", () => {
    it("adds tool_result with error message when stream errors during tool_use", async () => {
      const mockClient = new MockAnthropicClient();
      const agent = createAgent(mockClient);

      agent.appendUserMessage([{ type: "text", text: "Hello", nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX }]);
      await delay(0);
      agent.continueConversation();

      const stream = await mockClient.awaitStream();

      // Stream a tool_use block
      const toolUseId = "tool-error-test" as ToolRequestId;
      stream.streamToolUse(toolUseId, "get_file" as ToolName, {
        filePath: "test.ts",
      });
      await stream.settle();

      // Simulate a stream error
      stream.respondWithError(new Error("Connection lost"));

      await delay(10);

      const state = agent.getState();

      // Should have: user message, assistant with tool_use, user with tool_result
      expect(state.messages).toHaveLength(3);
      expect(state.messages[2].role).toBe("user");

      const toolResult = state.messages[2].content[0];
      expect(toolResult.type).toBe("tool_result");
      if (toolResult.type === "tool_result") {
        expect(toolResult.id).toBe(toolUseId);
        expect(toolResult.result.status).toBe("error");
        if (toolResult.result.status === "error") {
          expect(toolResult.result.error).toContain("Connection lost");
        }
      }

      expect(state.status.type).toBe("error");
    });

    it("removes server_tool_use block when stream errors during web search", async () => {
      const mockClient = new MockAnthropicClient();
      const agent = createAgent(mockClient);

      agent.appendUserMessage([{ type: "text", text: "Search for info", nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX }]);
      await delay(0);
      agent.continueConversation();

      const stream = await mockClient.awaitStream();

      // Stream some text first
      stream.streamText("Let me search for that.");

      // Stream a server_tool_use block
      stream.streamServerToolUse("server-tool-2", "web_search", {
        query: "test query",
      });
      await stream.settle();

      // Simulate a stream error
      stream.respondWithError(new Error("API timeout"));

      await delay(10);

      const state = agent.getState();

      // Should have: user message, assistant with just text (server_tool_use removed)
      expect(state.messages).toHaveLength(2);
      expect(state.messages[1].role).toBe("assistant");
      expect(state.messages[1].content).toHaveLength(1);
      expect(state.messages[1].content[0].type).toBe("text");

      expect(state.status.type).toBe("error");
    });
  });

  describe("latestUsage", () => {
    it("tracks usage from successful responses", async () => {
      const mockClient = new MockAnthropicClient();
      const agent = createAgent(mockClient);

      agent.appendUserMessage([{ type: "text", text: "Hello", nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX }]);
      await delay(0);
      agent.continueConversation();

      const stream = await mockClient.awaitStream();
      stream.streamText("Hello there!");
      stream.finishResponse("end_turn", {
        inputTokens: 100,
        outputTokens: 50,
        cacheHits: 10,
        cacheMisses: 5,
      });

      await stream.finalMessage();
      await delay(0);

      const state = agent.getState();
      expect(state.latestUsage).toEqual({
        inputTokens: 100,
        outputTokens: 50,
        cacheHits: 10,
        cacheMisses: 5,
      });
    });

    it("preserves latestUsage when subsequent request is aborted", async () => {
      const mockClient = new MockAnthropicClient();
      const agent = createAgent(mockClient);

      // First request - successful
      agent.appendUserMessage([{ type: "text", text: "Hello", nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX }]);
      await delay(0);
      agent.continueConversation();

      const stream1 = await mockClient.awaitStream();
      stream1.streamText("Hello there!");
      stream1.finishResponse("end_turn", {
        inputTokens: 100,
        outputTokens: 50,
      });

      await stream1.finalMessage();
      await delay(0);

      // Verify initial usage
      expect(agent.getState().latestUsage).toEqual({
        inputTokens: 100,
        outputTokens: 50,
      });

      // Second request - will be aborted
      agent.appendUserMessage([{ type: "text", text: "Follow up", nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX }]);
      await delay(0);
      agent.continueConversation();

      const stream2 = await mockClient.awaitStream();
      stream2.streamText("Starting to respond...");

      // Abort the second request
      await agent.abort();
      await delay(0);

      // latestUsage should still reflect the first successful request
      const state = agent.getState();
      expect(state.status).toEqual({ type: "stopped", stopReason: "aborted" });
      expect(state.latestUsage).toEqual({
        inputTokens: 100,
        outputTokens: 50,
      });
    });

    it("preserves latestUsage when subsequent request errors", async () => {
      const mockClient = new MockAnthropicClient();
      const agent = createAgent(mockClient);

      // First request - successful
      agent.appendUserMessage([{ type: "text", text: "Hello", nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX }]);
      await delay(0);
      agent.continueConversation();

      const stream1 = await mockClient.awaitStream();
      stream1.streamText("Hello there!");
      stream1.finishResponse("end_turn", {
        inputTokens: 200,
        outputTokens: 75,
        cacheHits: 20,
      });

      await stream1.finalMessage();
      await delay(0);

      // Verify initial usage
      expect(agent.getState().latestUsage).toEqual({
        inputTokens: 200,
        outputTokens: 75,
        cacheHits: 20,
      });

      // Second request - will error
      agent.appendUserMessage([{ type: "text", text: "Follow up", nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX }]);
      await delay(0);
      agent.continueConversation();

      const stream2 = await mockClient.awaitStream();
      stream2.streamText("Starting to respond...");
      await stream2.settle();

      // Simulate an error
      stream2.respondWithError(new Error("Connection lost"));
      await delay(10);

      // latestUsage should still reflect the first successful request
      const state = agent.getState();
      expect(state.status.type).toBe("error");
      expect(state.latestUsage).toEqual({
        inputTokens: 200,
        outputTokens: 75,
        cacheHits: 20,
      });
    });

    it("updates latestUsage only on successful responses", async () => {
      const mockClient = new MockAnthropicClient();
      const agent = createAgent(mockClient);

      // Initially undefined
      expect(agent.getState().latestUsage).toBeUndefined();

      // First request - abort (should not set latestUsage)
      agent.appendUserMessage([{ type: "text", text: "First", nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX }]);
      await delay(0);
      agent.continueConversation();
      const stream1 = await mockClient.awaitStream();
      stream1.streamText("Partial...");
      await agent.abort();
      await delay(0);

      expect(agent.getState().latestUsage).toBeUndefined();

      // Second request - successful (should set latestUsage)
      agent.appendUserMessage([{ type: "text", text: "Second", nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX }]);
      await delay(0);
      agent.continueConversation();
      const stream2 = await mockClient.awaitStream();
      stream2.streamText("Complete response");
      stream2.finishResponse("end_turn", {
        inputTokens: 150,
        outputTokens: 60,
      });

      await stream2.finalMessage();
      await delay(0);

      expect(agent.getState().latestUsage).toEqual({
        inputTokens: 150,
        outputTokens: 60,
      });
    });
  });

  describe("malformed tool_use handling", () => {
    it("produces error request for tool_use with invalid input", async () => {
      const mockClient = new MockAnthropicClient();
      const agent = createAgent(mockClient);

      agent.appendUserMessage([{ type: "text", text: "Hello", nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX }]);
      await delay(0);
      agent.continueConversation();

      const stream = await mockClient.awaitStream();
      // Stream a tool_use with missing required field (filePath)
      stream.streamToolUse(
        "tool-malformed" as ToolRequestId,
        "get_file" as ToolName,
        {},
      );
      stream.finishResponse("tool_use");

      await stream.finalMessage();
      await delay(0);

      const state = agent.getState();
      expect(state.messages).toHaveLength(2);
      const assistantContent = state.messages[1].content;
      const toolUseBlock = assistantContent.find((b) => b.type === "tool_use");
      expect(toolUseBlock).toBeDefined();
      if (toolUseBlock?.type === "tool_use") {
        expect(toolUseBlock.request.status).toBe("error");
      }
    });

    it("accepts error tool_result for malformed tool_use block", async () => {
      const mockClient = new MockAnthropicClient();
      const agent = createAgent(mockClient);

      agent.appendUserMessage([{ type: "text", text: "Hello", nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX }]);
      await delay(0);
      agent.continueConversation();

      const stream = await mockClient.awaitStream();
      const toolUseId = "tool-malformed" as ToolRequestId;
      stream.streamToolUse(toolUseId, "get_file" as ToolName, {});
      stream.finishResponse("tool_use");

      await stream.finalMessage();
      await delay(0);

      // Send error tool_result for the malformed block
      agent.toolResult(toolUseId, {
        type: "tool_result",
        id: toolUseId,
        result: {
          status: "error",
          error: "Malformed tool_use block: missing filePath",
        },
        nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
      });

      const state = agent.getState();
      expect(state.messages).toHaveLength(3);
      expect(state.messages[2].role).toBe("user");
      expect(state.messages[2].content[0].type).toBe("tool_result");

      // Should be able to continue the conversation
      agent.continueConversation();
      const stream2 = await mockClient.awaitStream();
      stream2.streamText("OK, I'll fix that.");
      stream2.finishResponse("end_turn");
      await stream2.finalMessage();
      await delay(0);

      expect(agent.getState().messages).toHaveLength(4);
    });
  });
  describe("context_update detection", () => {
    it("converts text blocks with <context_update> tags to context_update type", () => {
      const mockClient = new MockAnthropicClient();
      const agent = createAgent(mockClient);

      const contextUpdateText = `<context_update>
These files are part of your context.
File \`test.ts\`
const x = 1;
</context_update>`;

      agent.appendUserMessage([{ type: "text", text: contextUpdateText, nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX }]);

      const state = agent.getState();
      expect(state.messages).toHaveLength(1);
      expect(state.messages[0].content[0].type).toBe("context_update");
      if (state.messages[0].content[0].type === "context_update") {
        expect(state.messages[0].content[0].text).toBe(contextUpdateText);
      }
    });

    it("does not convert regular text to context_update type", () => {
      const mockClient = {} as Anthropic;
      const agent = createAgent(mockClient);

      agent.appendUserMessage([
        { type: "text", text: "Hello, this is regular text", nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX },
      ]);

      const state = agent.getState();
      expect(state.messages[0].content[0].type).toBe("text");
    });

    it("converts context_update in multi-content messages correctly", () => {
      const mockClient = new MockAnthropicClient();
      const agent = createAgent(mockClient);

      const contextUpdateText = `<context_update>
File context here
</context_update>`;

      agent.appendUserMessage([
        { type: "text", text: contextUpdateText, nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX },
        { type: "text", text: "Now here is my question", nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX },
      ]);

      const state = agent.getState();
      expect(state.messages).toHaveLength(1);
      expect(state.messages[0].content).toHaveLength(2);
      expect(state.messages[0].content[0].type).toBe("context_update");
      expect(state.messages[0].content[1].type).toBe("text");
    });
  });

  describe("clone", () => {
    it("creates a deep copy of the agent with all messages", async () => {
      const mockClient = new MockAnthropicClient();
      const tracked = trackMessages();
      const agent = createAgent(mockClient, undefined, tracked);

      // Build up some conversation history
      agent.appendUserMessage([{ type: "text", text: "Hello", nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX }]);
      agent.continueConversation();

      const stream = await mockClient.awaitStream();
      stream.streamText("Hi there!");
      stream.finishResponse("end_turn");
      await stream.finalMessage();
      await delay(0);

      agent.appendUserMessage([{ type: "text", text: "How are you?", nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX }]);
      agent.continueConversation();

      const stream2 = await mockClient.awaitStream();
      stream2.streamText("I'm doing well!");
      stream2.finishResponse("end_turn");
      await stream2.finalMessage();
      await delay(0);

      // Clone the agent
      const clonedTracked = trackMessages();
      const cloned = agent.clone();
      cloned.on("didUpdate", () => {
        clonedTracked.messages.push({ type: "agent-content-updated" });
      });
      cloned.on("stopped", (stopReason, usage) => {
        clonedTracked.messages.push({
          type: "agent-stopped",
          stopReason,
          ...(usage && { usage }),
        });
      });
      cloned.on("error", (error) => {
        clonedTracked.messages.push({ type: "agent-error", error });
      });

      // Verify cloned agent has same messages
      expect(cloned.getState().messages).toHaveLength(4);
      expect(cloned.getState().messages[0].role).toBe("user");
      expect(cloned.getState().messages[1].role).toBe("assistant");
      expect(cloned.getState().messages[2].role).toBe("user");
      expect(cloned.getState().messages[3].role).toBe("assistant");

      // Verify content is copied
      const clonedState = cloned.getState();
      expect(clonedState.messages[0].content[0]).toMatchObject({
        type: "text",
        text: "Hello",
      });
      expect(clonedState.messages[1].content[0]).toMatchObject({
        type: "text",
        text: "Hi there!",
      });
    });

    it("creates independent copy - changes to original don't affect clone", async () => {
      const mockClient = new MockAnthropicClient();
      const agent = createAgent(mockClient);

      agent.appendUserMessage([{ type: "text", text: "Hello", nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX }]);
      agent.continueConversation();

      const stream = await mockClient.awaitStream();
      stream.streamText("Hi!");
      stream.finishResponse("end_turn");
      await stream.finalMessage();
      await delay(0);

      // Clone the agent
      const cloned = agent.clone();

      // Add more messages to original
      agent.appendUserMessage([{ type: "text", text: "Another message", nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX }]);
      await delay(0);

      // Clone should not be affected
      expect(agent.getState().messages).toHaveLength(3);
      expect(cloned.getState().messages).toHaveLength(2);
    });

    it("clone while streaming with only a partial text block drops the empty assistant message", async () => {
      const mockClient = new MockAnthropicClient();
      const agent = createAgent(mockClient);

      agent.appendUserMessage([{ type: "text", text: "Hello", nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX }]);
      agent.continueConversation();

      const stream = await mockClient.awaitStream();
      expect(agent.getState().status.type).toBe("streaming");

      // Start a text block but don't finish it — stays in currentAnthropicBlock
      const index = stream.nextBlockIndex();
      stream.emitEvent({
        type: "content_block_start",
        index,
        content_block: { type: "text", text: "", citations: null },
      });
      stream.emitEvent({
        type: "content_block_delta",
        index,
        delta: { type: "text_delta", text: "partial" },
      });

      // Clone — currentAssistantMessage hasn't been created yet (no block-finished)
      const cloned = agent.clone();
      const clonedState = cloned.getState();

      // Only the user message should be present (no assistant message)
      expect(clonedState.messages).toHaveLength(1);
      expect(clonedState.messages[0].role).toBe("user");
      expect(clonedState.status).toEqual({
        type: "stopped",
        stopReason: "end_turn",
      });

      // Clean up source
      stream.emitEvent({ type: "content_block_stop", index });
      stream.finishResponse("end_turn");
      await stream.finalMessage();
    });

    it("clone while streaming with finalized text and in-progress tool_use keeps the text", async () => {
      const mockClient = new MockAnthropicClient();
      const agent = createAgent(mockClient);

      agent.appendUserMessage([{ type: "text", text: "Hello", nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX }]);
      agent.continueConversation();

      const stream = await mockClient.awaitStream();

      // Finalize a text block
      stream.streamText("Complete text");
      await stream.settle();

      // Start a tool_use block but don't finish it
      const toolIndex = stream.nextBlockIndex();
      stream.emitEvent({
        type: "content_block_start",
        index: toolIndex,
        content_block: {
          type: "tool_use",
          id: "tool-1" as ToolRequestId,
          name: "get_file" as ToolName,
          input: {},
          caller: { type: "direct" as const },
        },
      });
      await stream.settle();

      // Clone while tool_use is in-progress (in currentAnthropicBlock)
      const cloned = agent.clone();
      const clonedState = cloned.getState();

      // Should have user + assistant with just the finalized text
      expect(clonedState.messages[1].content).toHaveLength(1);
      expect(clonedState.messages[1].content[0].type).toBe("text");
      expect(clonedState.messages[1].content[0]).toHaveProperty(
        "text",
        "Complete text",
      );
      expect(clonedState.status).toEqual({
        type: "stopped",
        stopReason: "end_turn",
      });

      // Clean up source
      stream.emitEvent({ type: "content_block_stop", index: toolIndex });
      stream.finishResponse("end_turn");
      await stream.finalMessage();
    });

    it("clone while streaming with finalized server_tool_use drops it", async () => {
      const mockClient = new MockAnthropicClient();
      const agent = createAgent(mockClient);

      agent.appendUserMessage([{ type: "text", text: "Search for something", nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX }]);
      agent.continueConversation();

      const stream = await mockClient.awaitStream();

      // Finalize a server_tool_use block
      stream.streamServerToolUse("server-tool-1", "web_search", {
        query: "test query",
      });

      expect(agent.getState().status.type).toBe("streaming");

      // Clone — server_tool_use should be dropped, leaving empty assistant → removed
      const cloned = agent.clone();
      const clonedState = cloned.getState();

      expect(clonedState.messages).toHaveLength(1);
      expect(clonedState.messages[0].role).toBe("user");
      expect(clonedState.status).toEqual({
        type: "stopped",
        stopReason: "end_turn",
      });

      // Clean up source
      stream.finishResponse("end_turn");
      await stream.finalMessage();
    });

    it("clone while stopped on tool_use adds error tool_results", async () => {
      const mockClient = new MockAnthropicClient();
      const tracked = trackMessages();
      const agent = createAgent(mockClient, undefined, tracked);

      agent.appendUserMessage([{ type: "text", text: "Use a tool", nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX }]);
      agent.continueConversation();

      const stream = await mockClient.awaitStream();
      stream.streamText("I'll use the tool.");
      stream.streamToolUse(
        "tool-req-1" as ToolRequestId,
        "get_file" as ToolName,
        { filePath: "test.ts" },
      );
      stream.finishResponse("tool_use");
      await stream.finalMessage();
      await delay(0);

      expect(agent.getState().status).toEqual({
        type: "stopped",
        stopReason: "tool_use",
      });

      // Clone while stopped on tool_use
      const clonedTracked = trackMessages();
      const cloned = agent.clone();
      cloned.on("didUpdate", () => {
        clonedTracked.messages.push({ type: "agent-content-updated" });
      });
      cloned.on("stopped", (stopReason, usage) => {
        clonedTracked.messages.push({
          type: "agent-stopped",
          stopReason,
          ...(usage && { usage }),
        });
      });
      cloned.on("error", (error) => {
        clonedTracked.messages.push({ type: "agent-error", error });
      });
      const clonedState = cloned.getState();

      // Should have: user, assistant (text + tool_use), user (error tool_result)
      expect(clonedState.messages).toHaveLength(3);
      expect(clonedState.messages[1].role).toBe("assistant");
      expect(clonedState.messages[1].content).toHaveLength(2);
      expect(clonedState.messages[1].content[0].type).toBe("text");
      expect(clonedState.messages[1].content[0]).toHaveProperty(
        "text",
        "I'll use the tool.",
      );
      expect(clonedState.messages[1].content[1].type).toBe("tool_use");
      expect(clonedState.messages[1].content[1]).toHaveProperty(
        "id",
        "tool-req-1",
      );
      expect(clonedState.messages[1].content[1]).toHaveProperty(
        "name",
        "get_file",
      );
      expect(clonedState.messages[2].role).toBe("user");
      expect(clonedState.messages[2].content).toHaveLength(1);
      expect(clonedState.messages[2].content[0]).toMatchObject({
        type: "tool_result",
        id: "tool-req-1",
        result: {
          status: "error",
          error: "The thread was forked before the tool could execute.",
      nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
    },
      });
      expect(clonedState.status).toEqual({
        type: "stopped",
        stopReason: "end_turn",
      });

      // Source agent should be unchanged
      expect(agent.getState().status).toEqual({
        type: "stopped",
        stopReason: "tool_use",
      });
      expect(agent.getState().messages).toHaveLength(2);
    });

    it("source agent continues streaming unaffected after clone", async () => {
      const mockClient = new MockAnthropicClient();
      const tracked = trackMessages();
      const agent = createAgent(mockClient, undefined, tracked);

      agent.appendUserMessage([{ type: "text", text: "Hello", nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX }]);
      agent.continueConversation();

      const stream = await mockClient.awaitStream();
      stream.streamText("First part");
      await stream.settle();

      // Clone mid-stream
      const cloned = agent.clone();

      // Continue streaming on source
      stream.streamText("Second part");
      stream.finishResponse("end_turn");
      await stream.finalMessage();
      await delay(0);

      // Source should have the complete response
      const sourceState = agent.getState();
      expect(sourceState.status).toEqual({
        type: "stopped",
        stopReason: "end_turn",
      });
      expect(sourceState.messages).toHaveLength(2);
      expect(sourceState.messages[1].content).toHaveLength(2);
      expect(sourceState.messages[1].content[0]).toHaveProperty(
        "text",
        "First part",
      );
      expect(sourceState.messages[1].content[1]).toHaveProperty(
        "text",
        "Second part",
      );

      // Clone should only have the snapshot from before
      const clonedState = cloned.getState();
      expect(clonedState.messages).toHaveLength(2);
      expect(clonedState.messages[1].content).toHaveLength(1);
      expect(clonedState.messages[1].content[0]).toHaveProperty(
        "text",
        "First part",
      );
    });

    it("preserves stop info for messages", async () => {
      const mockClient = new MockAnthropicClient();
      const agent = createAgent(mockClient);

      agent.appendUserMessage([{ type: "text", text: "Hello", nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX }]);
      agent.continueConversation();

      const stream = await mockClient.awaitStream();
      stream.streamText("Hi!");
      stream.finishResponse("end_turn");
      await stream.finalMessage();
      await delay(0);

      // Clone the agent
      const cloned = agent.clone();

      // Verify stop reason is preserved
      const clonedState = cloned.getState();
      expect(clonedState.messages[1].stopReason).toBe("end_turn");
      expect(clonedState.status).toEqual({
        type: "stopped",
        stopReason: "end_turn",
      });
    });

    it("cloned agent can append messages independently", async () => {
      const mockClient = new MockAnthropicClient();
      const agent = createAgent(mockClient);

      agent.appendUserMessage([{ type: "text", text: "Hello", nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX }]);
      agent.continueConversation();

      const stream = await mockClient.awaitStream();
      stream.streamText("Hi!");
      stream.finishResponse("end_turn");
      await stream.finalMessage();
      await delay(0);

      // Clone the agent
      const cloned = agent.clone();

      // Append message to cloned agent (without streaming)
      cloned.appendUserMessage([{ type: "text", text: "From clone", nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX }]);
      await delay(0);

      // Cloned agent has the new message
      expect(cloned.getState().messages).toHaveLength(3);
      expect(cloned.getState().messages[2].content[0]).toMatchObject({
        type: "text",
        text: "From clone",
      });

      // Original is unchanged
      expect(agent.getState().messages).toHaveLength(2);
    });
  });

  describe("truncateMessages", () => {
    it("truncates at an assistant text-only message keeping [0..N]", async () => {
      const mockClient = new MockAnthropicClient();
      const agent = createAgent(mockClient);

      agent.appendUserMessage([{ type: "text", text: "Q1", nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX }]);
      await delay(0);
      agent.continueConversation();
      let stream = await mockClient.awaitStream();
      stream.streamText("A1");
      stream.finishResponse("end_turn");
      await stream.finalMessage();

      agent.appendUserMessage([{ type: "text", text: "Q2", nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX }]);
      await delay(0);
      agent.continueConversation();
      stream = await mockClient.awaitStream();
      stream.streamText("A2");
      stream.finishResponse("end_turn");
      await stream.finalMessage();

      // messages: [user Q1, assistant A1, user Q2, assistant A2]
      const messageIdx = 1 as never;
      agent.truncateMessages(messageIdx);

      expect(agent.getState().messages).toHaveLength(2);
      expect(agent.getState().status).toEqual({
        type: "stopped",
        stopReason: "end_turn",
      });
    });

    it("truncates at assistant tool_use message and extends to keep tool_result", async () => {
      const mockClient = new MockAnthropicClient();
      const agent = createAgent(mockClient);

      agent.appendUserMessage([{ type: "text", text: "Run tool", nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX }]);
      await delay(0);
      agent.continueConversation();
      const stream = await mockClient.awaitStream();
      stream.streamText("Running...");
      stream.streamToolUse("tool-1" as ToolRequestId, "get_file" as ToolName, {
        filePath: "x.ts",
      });
      stream.finishResponse("tool_use");
      await stream.finalMessage();
      await new Promise((resolve) => setTimeout(resolve, 0));

      agent.toolResult("tool-1" as ToolRequestId, {
        type: "tool_result",
        id: "tool-1" as ToolRequestId,
        result: {
          status: "ok",
          value: [{ type: "text", text: "file contents", nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX }],
          structuredResult: { toolName: "get_file" as ToolName },
        },
        nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
      });

      agent.continueConversation();
      const followup = await mockClient.awaitStream();
      followup.streamText("Done.");
      followup.finishResponse("end_turn");
      await followup.finalMessage();

      // messages: [user Run, assistant w/tool_use, user tool_result, assistant Done]
      expect(agent.getState().messages).toHaveLength(4);

      // Truncate at the assistant message that contains tool_use (idx=1).
      // Should extend to keep idx=2 (tool_result) too.
      agent.truncateMessages(1 as never);
      expect(agent.getState().messages).toHaveLength(3);
      expect(agent.getState().messages[1].role).toBe("assistant");
      expect(agent.getState().messages[2].role).toBe("user");
    });

    it("drops orphan tool_use blocks when no matching tool_result follows", async () => {
      const mockClient = new MockAnthropicClient();
      const agent = createAgent(mockClient);

      agent.appendUserMessage([{ type: "text", text: "Run tool", nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX }]);
      await delay(0);
      agent.continueConversation();
      const stream = await mockClient.awaitStream();
      stream.streamText("Running.");
      stream.streamToolUse(
        "orphan-1" as ToolRequestId,
        "get_file" as ToolName,
        { filePath: "x.ts" },
      );
      stream.finishResponse("tool_use");
      await stream.finalMessage();
      await new Promise((resolve) => setTimeout(resolve, 0));

      // No tool_result has been provided yet — truncate at the assistant idx
      agent.truncateMessages(1 as never);

      const messages = agent.getState().messages;
      // Assistant message should still exist with text but no tool_use
      expect(messages).toHaveLength(2);
      expect(messages[1].role).toBe("assistant");
      const content = messages[1].content;
      expect(Array.isArray(content)).toBe(true);
      if (Array.isArray(content)) {
        expect(content.some((c) => c.type === "tool_use")).toBe(false);
      }
    });

    it("drops the entire assistant message if it only contained an orphan tool_use", async () => {
      const mockClient = new MockAnthropicClient();
      const agent = createAgent(mockClient);

      agent.appendUserMessage([{ type: "text", text: "Run tool", nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX }]);
      await delay(0);
      agent.continueConversation();
      const stream = await mockClient.awaitStream();
      stream.streamToolUse(
        "orphan-2" as ToolRequestId,
        "get_file" as ToolName,
        { filePath: "x.ts" },
      );
      stream.finishResponse("tool_use");
      await stream.finalMessage();
      await new Promise((resolve) => setTimeout(resolve, 0));

      // messages: [user, assistant w/only tool_use]
      agent.truncateMessages(1 as never);

      // Assistant message should be dropped entirely
      const messages = agent.getState().messages;
      expect(messages).toHaveLength(1);
      expect(messages[0].role).toBe("user");
    });

    it("clears messageStopInfo entries after the cut", async () => {
      const mockClient = new MockAnthropicClient();
      const agent = createAgent(mockClient);

      agent.appendUserMessage([{ type: "text", text: "Q1", nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX }]);
      await delay(0);
      agent.continueConversation();
      let stream = await mockClient.awaitStream();
      stream.streamText("A1");
      stream.finishResponse("end_turn");
      await stream.finalMessage();

      agent.appendUserMessage([{ type: "text", text: "Q2", nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX }]);
      await delay(0);
      agent.continueConversation();
      stream = await mockClient.awaitStream();
      stream.streamText("A2");
      stream.finishResponse("end_turn");
      await stream.finalMessage();

      // Cut at index 1
      agent.truncateMessages(1 as never);

      const messagesAfter = agent.getState().messages;
      // Only the first assistant should still have stop info
      expect(messagesAfter[1].stopReason).toBe("end_turn");
    });
  });
});
