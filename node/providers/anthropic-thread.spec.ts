import { describe, it, expect } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import {
  AnthropicProviderThread,
  type AnthropicThreadOptions,
} from "./anthropic-thread.ts";
import type {
  ProviderThreadInput,
  ProviderThreadStatus,
  ProviderToolResult,
  ProviderToolSpec,
} from "./provider-types.ts";
import type { ToolRequestId } from "../tools/toolManager.ts";
import { MockAnthropicClient } from "./mock-anthropic-client.ts";
import type { ToolName } from "../tools/types.ts";
import { delay } from "../utils/async.ts";

function createThread(
  mockClient: MockAnthropicClient | Anthropic,
  options?: Partial<typeof defaultOptions>,
): AnthropicProviderThread {
  return new AnthropicProviderThread(
    { ...defaultOptions, ...options },
    mockClient as unknown as Anthropic,
    defaultAnthropicOptions,
  );
}

type TrackedEvents = {
  statusChanges: ProviderThreadStatus[];
  messagesUpdated: number;
  streamingBlockUpdated: number;
};

function trackEvents(thread: AnthropicProviderThread): TrackedEvents {
  const events: TrackedEvents = {
    statusChanges: [],
    messagesUpdated: 0,
    streamingBlockUpdated: 0,
  };
  thread.on("status-changed", () =>
    events.statusChanges.push(thread.getState().status),
  );
  thread.on("messages-updated", () => events.messagesUpdated++);
  thread.on("streaming-block-updated", () => events.streamingBlockUpdated++);
  return events;
}

const defaultOptions = {
  model: "claude-sonnet-4-20250514",
  systemPrompt: "You are a helpful assistant.",
  tools: [] as ProviderToolSpec[],
};

const defaultAnthropicOptions: AnthropicThreadOptions = {
  authType: "max",
  includeWebSearch: true,
  disableParallelToolUseFlag: true,
};

describe("appendUserMessage", () => {
  it("does not add assistant message until first content block completes", async () => {
    const mockClient = new MockAnthropicClient();
    const thread = createThread(mockClient);

    thread.appendUserMessage([{ type: "text", text: "Hello" }]);
    thread.continueConversation();

    const stream = await mockClient.awaitStream();

    // Before any content blocks, should only have user message
    expect(thread.getState().messages).toHaveLength(1);
    expect(thread.getState().messages[0].role).toBe("user");

    // Start a text block
    const blockIndex = stream.nextBlockIndex();
    stream.emitEvent({
      type: "content_block_start",
      index: blockIndex,
      content_block: { type: "text", text: "", citations: null },
    });

    // Still only user message - assistant message not added yet
    expect(thread.getState().messages).toHaveLength(1);

    // Add some text delta
    stream.emitEvent({
      type: "content_block_delta",
      index: blockIndex,
      delta: { type: "text_delta", text: "Hello world" },
    });

    // Still only user message
    expect(thread.getState().messages).toHaveLength(1);

    // Complete the block
    stream.emitEvent({
      type: "content_block_stop",
      index: blockIndex,
    });

    // Now assistant message should be added
    expect(thread.getState().messages).toHaveLength(2);
    expect(thread.getState().messages[1].role).toBe("assistant");
    expect(thread.getState().messages[1].content).toHaveLength(1);

    stream.finishResponse("end_turn");
    await stream.finalMessage();
  });

  it("appends text message and emits messages-updated async", async () => {
    const mockClient = {} as Anthropic;
    const thread = createThread(mockClient);
    const events = trackEvents(thread);

    const content: ProviderThreadInput[] = [
      { type: "text", text: "Hello, world!" },
    ];
    thread.appendUserMessage(content);

    // Event should not have fired synchronously
    expect(events.messagesUpdated).toBe(0);

    const state = thread.getState();
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].role).toBe("user");
    expect(state.messages[0].content).toHaveLength(1);
    expect(state.messages[0].content[0]).toEqual({
      type: "text",
      text: "Hello, world!",
    });

    // Event fires asynchronously
    await delay(0);
    expect(events.messagesUpdated).toBe(1);
  });

  it("appends image message correctly", () => {
    const mockClient = {} as Anthropic;
    const thread = createThread(mockClient);

    const content: ProviderThreadInput[] = [
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: "base64data",
        },
      },
    ];
    thread.appendUserMessage(content);

    const state = thread.getState();
    expect(state.messages[0].content[0]).toEqual({
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
    const thread = createThread(mockClient);

    const content: ProviderThreadInput[] = [
      {
        type: "document",
        source: {
          type: "base64",
          media_type: "application/pdf",
          data: "pdfdata",
        },
        title: "My Document",
      },
    ];
    thread.appendUserMessage(content);

    const state = thread.getState();
    expect(state.messages[0].content[0]).toEqual({
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
    const thread = createThread(mockClient);

    const toolUseId = "tool-123" as ToolRequestId;
    const result: ProviderToolResult = {
      type: "tool_result",
      id: toolUseId,
      result: {
        status: "ok",
        value: [{ type: "text", text: "Tool output" }],
      },
    };

    expect(() => thread.toolResult(toolUseId, result)).toThrow(
      "Cannot provide tool result: expected status stopped",
    );
  });

  it("appends tool result when in correct state", async () => {
    const mockClient = new MockAnthropicClient();
    const thread = createThread(mockClient);

    const toolUseId = "tool-123" as ToolRequestId;

    // Send a message to trigger streaming, then respond with tool_use
    thread.appendUserMessage([{ type: "text", text: "Hello" }]);
    thread.continueConversation();

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
        value: [{ type: "text", text: "Tool output" }],
      },
    };

    thread.toolResult(toolUseId, result);

    const state = thread.getState();
    expect(state.messages).toHaveLength(3);
    expect(state.messages[2].role).toBe("user");

    const toolResult = state.messages[2].content[0];
    expect(toolResult.type).toBe("tool_result");
  });
});

describe("continueConversation", () => {
  it("throws when last message is from assistant", async () => {
    const mockClient = new MockAnthropicClient();
    const thread = createThread(mockClient);

    // Send a message and get a response
    thread.appendUserMessage([{ type: "text", text: "Hello" }]);
    thread.continueConversation();

    const stream = await mockClient.awaitStream();
    stream.streamText("Hello there!");
    stream.finishResponse("end_turn");

    await stream.finalMessage();
    await delay(0);

    // Now trying to continue should throw because last message is assistant
    expect(() => thread.continueConversation()).toThrow(
      "Cannot continue conversation: last message is from assistant",
    );
  });

  it("succeeds when last message is from user", () => {
    const mockClient = new MockAnthropicClient();
    const thread = createThread(mockClient);

    thread.appendUserMessage([{ type: "text", text: "Hello" }]);

    // Should not throw
    expect(() => thread.continueConversation()).not.toThrow();
  });
});

describe("events", () => {
  it("emits events when stream updates state", async () => {
    const mockClient = new MockAnthropicClient();
    const thread = createThread(mockClient);
    const events = trackEvents(thread);

    // appendUserMessage emits messages-updated async
    thread.appendUserMessage([{ type: "text", text: "Test" }]);
    expect(events.messagesUpdated).toBe(0);
    await delay(0);
    expect(events.messagesUpdated).toBe(1);

    // continueConversation triggers streaming which emits events
    thread.continueConversation();
    await delay(0);

    const stream = await mockClient.awaitStream();
    stream.streamText("Hello");
    await delay(0);
    expect(events.statusChanges.length).toBeGreaterThan(0);
    expect(events.statusChanges.some((s) => s.type === "streaming")).toBe(true);
    stream.finishResponse("end_turn");

    await stream.finalMessage();
    await delay(0);

    // Should have emitted status-changed, streaming-block-updated, messages-updated
    expect(events.statusChanges.length).toBeGreaterThan(0);
    expect(events.messagesUpdated).toBeGreaterThan(1);
  });
});

describe("abort", () => {
  it("does nothing when no active request", async () => {
    const mockClient = {} as Anthropic;
    const thread = createThread(mockClient);
    const events = trackEvents(thread);

    thread.abort();
    await delay(0);

    expect(events.statusChanges).toHaveLength(0);
    expect(thread.getState().status).toEqual({ type: "idle" });
  });

  it("sets stopped status with aborted reason when stream is active", async () => {
    const mockClient = new MockAnthropicClient();
    const thread = createThread(mockClient);
    const events = trackEvents(thread);

    thread.appendUserMessage([{ type: "text", text: "Hello" }]);
    thread.continueConversation();

    const stream = await mockClient.awaitStream();

    // Start streaming some text
    stream.streamText("Partial response");

    // Abort the request
    thread.abort();

    // Wait for the catch block to execute
    await delay(0);

    const state = thread.getState();
    expect(state.status).toEqual({
      type: "stopped",
      stopReason: "aborted",
    });

    expect(
      events.statusChanges.some(
        (s) => s.type === "stopped" && s.stopReason === "aborted",
      ),
    ).toBe(true);
  });

  it("adds tool_result with abort message when aborting during tool_use", async () => {
    const mockClient = new MockAnthropicClient();
    const thread = createThread(mockClient);

    thread.appendUserMessage([{ type: "text", text: "Hello" }]);
    thread.continueConversation();

    const stream = await mockClient.awaitStream();

    // Stream a tool_use block but don't finish the response
    const toolUseId = "tool-abort-test" as ToolRequestId;
    stream.streamToolUse(toolUseId, "get_file" as ToolName, {
      filePath: "test.ts",
    });

    // Abort while tool_use is the last block
    thread.abort();

    await new Promise((resolve) => setTimeout(resolve, 0));

    const state = thread.getState();

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
    const thread = createThread(mockClient);

    thread.appendUserMessage([{ type: "text", text: "Search for info" }]);
    thread.continueConversation();

    const stream = await mockClient.awaitStream();

    // Stream some text first
    stream.streamText("Let me search for that.");

    // Stream a server_tool_use block (web search)
    stream.streamServerToolUse("server-tool-1", "web_search", {
      query: "test query",
    });

    // Abort while waiting for web search results
    thread.abort();

    await new Promise((resolve) => setTimeout(resolve, 0));

    const state = thread.getState();

    // Should have: user message, assistant with just text (server_tool_use removed)
    expect(state.messages).toHaveLength(2);
    expect(state.messages[1].role).toBe("assistant");
    expect(state.messages[1].content).toHaveLength(1);
    expect(state.messages[1].content[0].type).toBe("text");
  });
});

describe("thinking blocks", () => {
  it("captures thinking content and signature during streaming", async () => {
    const mockClient = new MockAnthropicClient();
    const thread = createThread(mockClient);

    thread.appendUserMessage([{ type: "text", text: "Hello" }]);
    thread.continueConversation();

    const stream = await mockClient.awaitStream();

    const blockIndex = stream.nextBlockIndex();

    // Start thinking block
    stream.emitEvent({
      type: "content_block_start",
      index: blockIndex,
      content_block: { type: "thinking", thinking: "", signature: "" },
    });

    // Check streaming block is exposed
    let streamingBlock = thread.getProviderStreamingBlock();
    expect(streamingBlock).toBeDefined();
    expect(streamingBlock?.type).toBe("thinking");

    // Add thinking content
    stream.emitEvent({
      type: "content_block_delta",
      index: blockIndex,
      delta: { type: "thinking_delta", thinking: "Let me think about this..." },
    });

    streamingBlock = thread.getProviderStreamingBlock();
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

    streamingBlock = thread.getProviderStreamingBlock();
    if (streamingBlock?.type === "thinking") {
      expect(streamingBlock.thinking).toBe("Let me think about this...");
      expect(streamingBlock.signature).toBe("EqQBCgIYAhIM1gbcDa9GJwZA2b3h");
    }

    // Stop the block
    stream.emitEvent({
      type: "content_block_stop",
      index: blockIndex,
    });

    expect(thread.getProviderStreamingBlock()).toBeUndefined();

    // Check that the streamed content was captured in the message
    const state = thread.getState();
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
    thread.abort();
  });

  it("accumulates signature across multiple deltas", async () => {
    const mockClient = new MockAnthropicClient();
    const thread = createThread(mockClient);

    thread.appendUserMessage([{ type: "text", text: "Hello" }]);
    thread.continueConversation();

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

    const streamingBlock = thread.getProviderStreamingBlock();
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
    const thread = createThread(mockClient);

    thread.appendUserMessage([{ type: "text", text: "Hello" }]);
    thread.continueConversation();

    const stream = await mockClient.awaitStream();
    stream.streamThinking("Deep thoughts here", "signature123");
    stream.streamText("Here is my answer");
    stream.finishResponse("end_turn");

    await stream.finalMessage();
    await delay(0);

    const state = thread.getState();
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
    const thread = createThread(mockClient);

    thread.appendUserMessage([{ type: "text", text: "Hello" }]);
    thread.continueConversation();

    const stream = await mockClient.awaitStream();

    // Start a text block
    const blockIndex = stream.nextBlockIndex();
    stream.emitEvent({
      type: "content_block_start",
      index: blockIndex,
      content_block: { type: "text", text: "", citations: null },
    });

    // Check streaming block is exposed
    let streamingBlock = thread.getProviderStreamingBlock();
    expect(streamingBlock).toBeDefined();
    expect(streamingBlock?.type).toBe("text");

    // Add some text
    stream.emitEvent({
      type: "content_block_delta",
      index: blockIndex,
      delta: { type: "text_delta", text: "Hello world" },
    });

    streamingBlock = thread.getProviderStreamingBlock();
    expect(streamingBlock?.type).toBe("text");
    if (streamingBlock?.type === "text") {
      expect(streamingBlock.text).toBe("Hello world");
    }

    // Stop the block
    stream.emitEvent({
      type: "content_block_stop",
      index: blockIndex,
    });

    // Streaming block should be cleared
    expect(thread.getProviderStreamingBlock()).toBeUndefined();

    // Clean up
    stream.finishResponse("end_turn");
    await stream.finalMessage();
  });

  it("exposes tool_use streaming block during streaming", async () => {
    const mockClient = new MockAnthropicClient();
    const thread = createThread(mockClient);

    thread.appendUserMessage([{ type: "text", text: "Hello" }]);
    thread.continueConversation();

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
      },
    });

    let streamingBlock = thread.getProviderStreamingBlock();
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

    streamingBlock = thread.getProviderStreamingBlock();
    if (streamingBlock?.type === "tool_use") {
      expect(streamingBlock.inputJson).toBe('{"filePath":"test.ts"}');
    }

    // Stop the block
    stream.emitEvent({
      type: "content_block_stop",
      index: blockIndex,
    });

    expect(thread.getProviderStreamingBlock()).toBeUndefined();

    stream.finishResponse("tool_use");
    await stream.finalMessage();
  });

  it("returns undefined for server_tool_use blocks", async () => {
    const mockClient = new MockAnthropicClient();
    const thread = createThread(mockClient);

    thread.appendUserMessage([{ type: "text", text: "Search" }]);
    thread.continueConversation();

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

    // server_tool_use should not be exposed via getProviderStreamingBlock
    expect(thread.getProviderStreamingBlock()).toBeUndefined();

    stream.emitEvent({
      type: "content_block_stop",
      index: blockIndex,
    });

    stream.finishResponse("end_turn");
    await stream.finalMessage();
  });

  it("emits streaming-block-updated events during streaming", async () => {
    const mockClient = new MockAnthropicClient();
    const thread = createThread(mockClient);
    const events = trackEvents(thread);

    thread.appendUserMessage([{ type: "text", text: "Hello" }]);
    thread.continueConversation();

    const stream = await mockClient.awaitStream();

    // Reset counter after initial events
    await delay(0);
    events.streamingBlockUpdated = 0;

    stream.streamText("Hello world");
    await delay(0);

    // Should have emitted streaming-block-updated events
    expect(events.streamingBlockUpdated).toBeGreaterThan(0);

    stream.finishResponse("end_turn");
    await stream.finalMessage();
  });
});

describe("error handling with cleanup", () => {
  it("adds tool_result with error message when stream errors during tool_use", async () => {
    const mockClient = new MockAnthropicClient();
    const thread = createThread(mockClient);

    thread.appendUserMessage([{ type: "text", text: "Hello" }]);
    thread.continueConversation();

    const stream = await mockClient.awaitStream();

    // Stream a tool_use block
    const toolUseId = "tool-error-test" as ToolRequestId;
    stream.streamToolUse(toolUseId, "get_file" as ToolName, {
      filePath: "test.ts",
    });

    // Simulate a stream error
    stream.respondWithError(new Error("Connection lost"));

    await new Promise((resolve) => setTimeout(resolve, 0));

    const state = thread.getState();

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
    const thread = createThread(mockClient);

    thread.appendUserMessage([{ type: "text", text: "Search for info" }]);
    thread.continueConversation();

    const stream = await mockClient.awaitStream();

    // Stream some text first
    stream.streamText("Let me search for that.");

    // Stream a server_tool_use block
    stream.streamServerToolUse("server-tool-2", "web_search", {
      query: "test query",
    });

    // Simulate a stream error
    stream.respondWithError(new Error("API timeout"));

    await new Promise((resolve) => setTimeout(resolve, 0));

    const state = thread.getState();

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
    const thread = createThread(mockClient);

    thread.appendUserMessage([{ type: "text", text: "Hello" }]);
    thread.continueConversation();

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

    const state = thread.getState();
    expect(state.latestUsage).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cacheHits: 10,
      cacheMisses: 5,
    });
  });

  it("preserves latestUsage when subsequent request is aborted", async () => {
    const mockClient = new MockAnthropicClient();
    const thread = createThread(mockClient);

    // First request - successful
    thread.appendUserMessage([{ type: "text", text: "Hello" }]);
    thread.continueConversation();

    const stream1 = await mockClient.awaitStream();
    stream1.streamText("Hello there!");
    stream1.finishResponse("end_turn", {
      inputTokens: 100,
      outputTokens: 50,
    });

    await stream1.finalMessage();
    await delay(0);

    // Verify initial usage
    expect(thread.getState().latestUsage).toEqual({
      inputTokens: 100,
      outputTokens: 50,
    });

    // Second request - will be aborted
    thread.appendUserMessage([{ type: "text", text: "Follow up" }]);
    thread.continueConversation();

    const stream2 = await mockClient.awaitStream();
    stream2.streamText("Starting to respond...");

    // Abort the second request
    thread.abort();
    await delay(0);

    // latestUsage should still reflect the first successful request
    const state = thread.getState();
    expect(state.status).toEqual({ type: "stopped", stopReason: "aborted" });
    expect(state.latestUsage).toEqual({
      inputTokens: 100,
      outputTokens: 50,
    });
  });

  it("preserves latestUsage when subsequent request errors", async () => {
    const mockClient = new MockAnthropicClient();
    const thread = createThread(mockClient);

    // First request - successful
    thread.appendUserMessage([{ type: "text", text: "Hello" }]);
    thread.continueConversation();

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
    expect(thread.getState().latestUsage).toEqual({
      inputTokens: 200,
      outputTokens: 75,
      cacheHits: 20,
    });

    // Second request - will error
    thread.appendUserMessage([{ type: "text", text: "Follow up" }]);
    thread.continueConversation();

    const stream2 = await mockClient.awaitStream();
    stream2.streamText("Starting to respond...");

    // Simulate an error
    stream2.respondWithError(new Error("Connection lost"));
    await delay(0);

    // latestUsage should still reflect the first successful request
    const state = thread.getState();
    expect(state.status.type).toBe("error");
    expect(state.latestUsage).toEqual({
      inputTokens: 200,
      outputTokens: 75,
      cacheHits: 20,
    });
  });

  it("updates latestUsage only on successful responses", async () => {
    const mockClient = new MockAnthropicClient();
    const thread = createThread(mockClient);

    // Initially undefined
    expect(thread.getState().latestUsage).toBeUndefined();

    // First request - abort (should not set latestUsage)
    thread.appendUserMessage([{ type: "text", text: "First" }]);
    thread.continueConversation();
    const stream1 = await mockClient.awaitStream();
    stream1.streamText("Partial...");
    thread.abort();
    await delay(0);

    expect(thread.getState().latestUsage).toBeUndefined();

    // Second request - successful (should set latestUsage)
    thread.appendUserMessage([{ type: "text", text: "Second" }]);
    thread.continueConversation();
    const stream2 = await mockClient.awaitStream();
    stream2.streamText("Complete response");
    stream2.finishResponse("end_turn", {
      inputTokens: 150,
      outputTokens: 60,
    });

    await stream2.finalMessage();
    await delay(0);

    expect(thread.getState().latestUsage).toEqual({
      inputTokens: 150,
      outputTokens: 60,
    });
  });
});

describe("context_update detection", () => {
  it("converts text blocks with <context_update> tags to context_update type", () => {
    const mockClient = new MockAnthropicClient();
    const thread = createThread(mockClient);

    const contextUpdateText = `<context_update>
These files are part of your context.
File \`test.ts\`
const x = 1;
</context_update>`;

    thread.appendUserMessage([{ type: "text", text: contextUpdateText }]);

    const state = thread.getState();
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].content[0].type).toBe("context_update");
    if (state.messages[0].content[0].type === "context_update") {
      expect(state.messages[0].content[0].text).toBe(contextUpdateText);
    }
  });

  it("does not convert regular text to context_update type", () => {
    const mockClient = {} as Anthropic;
    const thread = createThread(mockClient);

    thread.appendUserMessage([
      { type: "text", text: "Hello, this is regular text" },
    ]);

    const state = thread.getState();
    expect(state.messages[0].content[0].type).toBe("text");
  });

  it("converts context_update in multi-content messages correctly", () => {
    const mockClient = new MockAnthropicClient();
    const thread = createThread(mockClient);

    const contextUpdateText = `<context_update>
File context here
</context_update>`;

    thread.appendUserMessage([
      { type: "text", text: contextUpdateText },
      { type: "text", text: "Now here is my question" },
    ]);

    const state = thread.getState();
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].content).toHaveLength(2);
    expect(state.messages[0].content[0].type).toBe("context_update");
    expect(state.messages[0].content[1].type).toBe("text");
  });
});
