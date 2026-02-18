import { describe, it, expect } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import {
  AnthropicAgent,
  type AnthropicAgentOptions,
} from "./anthropic-agent.ts";
import type {
  AgentInput,
  AgentMsg,
  ProviderToolResult,
  ProviderToolSpec,
} from "./provider-types.ts";
import type { ToolRequestId } from "../tools/toolManager.ts";
import { MockAnthropicClient } from "./mock-anthropic-client.ts";
import type { ToolName } from "../tools/types.ts";
import { delay } from "../utils/async.ts";

type TrackedMessages = {
  messages: AgentMsg[];
};

function createAgent(
  mockClient: MockAnthropicClient | Anthropic,
  options?: Partial<typeof defaultOptions>,
  tracked?: TrackedMessages,
): AnthropicAgent {
  const dispatch = (msg: AgentMsg) => {
    if (tracked) {
      tracked.messages.push(msg);
    }
  };
  return new AnthropicAgent(
    { ...defaultOptions, ...options },
    mockClient as unknown as Anthropic,
    dispatch,
    defaultAnthropicOptions,
  );
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
};

describe("appendUserMessage", () => {
  it("does not add assistant message until first content block completes", async () => {
    const mockClient = new MockAnthropicClient();
    const agent = createAgent(mockClient);

    agent.appendUserMessage([{ type: "text", text: "Hello" }]);
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

    // Still only user message - assistant message not added yet
    expect(agent.getState().messages).toHaveLength(1);

    // Add some text delta
    stream.emitEvent({
      type: "content_block_delta",
      index: blockIndex,
      delta: { type: "text_delta", text: "Hello world" },
    });

    // Still only user message
    expect(agent.getState().messages).toHaveLength(1);

    // Complete the block
    stream.emitEvent({
      type: "content_block_stop",
      index: blockIndex,
    });

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

    const content: AgentInput[] = [{ type: "text", text: "Hello, world!" }];
    agent.appendUserMessage(content);

    // Message should not have been dispatched synchronously
    expect(tracked.messages).toHaveLength(0);

    const state = agent.getState();
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].role).toBe("user");
    expect(state.messages[0].content).toHaveLength(1);
    expect(state.messages[0].content[0]).toEqual({
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
      },
    ];
    agent.appendUserMessage(content);

    const state = agent.getState();
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
      },
    ];
    agent.appendUserMessage(content);

    const state = agent.getState();
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
    const agent = createAgent(mockClient);

    const toolUseId = "tool-123" as ToolRequestId;
    const result: ProviderToolResult = {
      type: "tool_result",
      id: toolUseId,
      result: {
        status: "ok",
        value: [{ type: "text", text: "Tool output" }],
      },
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
    agent.appendUserMessage([{ type: "text", text: "Hello" }]);
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
        value: [{ type: "text", text: "Tool output" }],
      },
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

    agent.appendUserMessage([{ type: "text", text: "Hello" }]);

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
    agent.appendUserMessage([{ type: "text", text: "Test" }]);
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

    agent.appendUserMessage([{ type: "text", text: "Hello" }]);
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

    agent.appendUserMessage([{ type: "text", text: "Hello" }]);
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

    agent.appendUserMessage([{ type: "text", text: "Search for info" }]);
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

    agent.appendUserMessage([{ type: "text", text: "Hello" }]);
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

    agent.appendUserMessage([{ type: "text", text: "Hello" }]);
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

    agent.appendUserMessage([{ type: "text", text: "Hello" }]);
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

    agent.appendUserMessage([{ type: "text", text: "Hello" }]);
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

    agent.appendUserMessage([{ type: "text", text: "Hello" }]);
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

    agent.appendUserMessage([{ type: "text", text: "Hello" }]);
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

    agent.appendUserMessage([{ type: "text", text: "Hello" }]);
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

    // Streaming block should be cleared
    expect(agent.getStreamingBlock()).toBeUndefined();

    // Clean up
    stream.finishResponse("end_turn");
    await stream.finalMessage();
  });

  it("exposes tool_use streaming block during streaming", async () => {
    const mockClient = new MockAnthropicClient();
    const agent = createAgent(mockClient);

    agent.appendUserMessage([{ type: "text", text: "Hello" }]);
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
      },
    });

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

    streamingBlock = agent.getStreamingBlock();
    if (streamingBlock?.type === "tool_use") {
      expect(streamingBlock.inputJson).toBe('{"filePath":"test.ts"}');
    }

    // Stop the block
    stream.emitEvent({
      type: "content_block_stop",
      index: blockIndex,
    });

    expect(agent.getStreamingBlock()).toBeUndefined();

    stream.finishResponse("tool_use");
    await stream.finalMessage();
  });

  it("returns undefined for server_tool_use blocks", async () => {
    const mockClient = new MockAnthropicClient();
    const agent = createAgent(mockClient);

    agent.appendUserMessage([{ type: "text", text: "Search" }]);
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

    agent.appendUserMessage([{ type: "text", text: "Hello" }]);
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

describe("error handling with cleanup", () => {
  it("adds tool_result with error message when stream errors during tool_use", async () => {
    const mockClient = new MockAnthropicClient();
    const agent = createAgent(mockClient);

    agent.appendUserMessage([{ type: "text", text: "Hello" }]);
    await delay(0);
    agent.continueConversation();

    const stream = await mockClient.awaitStream();

    // Stream a tool_use block
    const toolUseId = "tool-error-test" as ToolRequestId;
    stream.streamToolUse(toolUseId, "get_file" as ToolName, {
      filePath: "test.ts",
    });

    // Simulate a stream error
    stream.respondWithError(new Error("Connection lost"));

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
        expect(toolResult.result.error).toContain("Connection lost");
      }
    }

    expect(state.status.type).toBe("error");
  });

  it("removes server_tool_use block when stream errors during web search", async () => {
    const mockClient = new MockAnthropicClient();
    const agent = createAgent(mockClient);

    agent.appendUserMessage([{ type: "text", text: "Search for info" }]);
    await delay(0);
    agent.continueConversation();

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

    agent.appendUserMessage([{ type: "text", text: "Hello" }]);
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
    agent.appendUserMessage([{ type: "text", text: "Hello" }]);
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
    agent.appendUserMessage([{ type: "text", text: "Follow up" }]);
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
    agent.appendUserMessage([{ type: "text", text: "Hello" }]);
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
    agent.appendUserMessage([{ type: "text", text: "Follow up" }]);
    await delay(0);
    agent.continueConversation();

    const stream2 = await mockClient.awaitStream();
    stream2.streamText("Starting to respond...");

    // Simulate an error
    stream2.respondWithError(new Error("Connection lost"));
    await delay(0);

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
    agent.appendUserMessage([{ type: "text", text: "First" }]);
    await delay(0);
    agent.continueConversation();
    const stream1 = await mockClient.awaitStream();
    stream1.streamText("Partial...");
    await agent.abort();
    await delay(0);

    expect(agent.getState().latestUsage).toBeUndefined();

    // Second request - successful (should set latestUsage)
    agent.appendUserMessage([{ type: "text", text: "Second" }]);
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

describe("context_update detection", () => {
  it("converts text blocks with <context_update> tags to context_update type", () => {
    const mockClient = new MockAnthropicClient();
    const agent = createAgent(mockClient);

    const contextUpdateText = `<context_update>
These files are part of your context.
File \`test.ts\`
const x = 1;
</context_update>`;

    agent.appendUserMessage([{ type: "text", text: contextUpdateText }]);

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
      { type: "text", text: "Hello, this is regular text" },
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
      { type: "text", text: contextUpdateText },
      { type: "text", text: "Now here is my question" },
    ]);

    const state = agent.getState();
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].content).toHaveLength(2);
    expect(state.messages[0].content[0].type).toBe("context_update");
    expect(state.messages[0].content[1].type).toBe("text");
  });
});

describe("compact", () => {
  it("replaces entire thread with summary", async () => {
    const mockClient = new MockAnthropicClient();
    const agent = createAgent(mockClient);

    // Build a conversation
    agent.appendUserMessage([{ type: "text", text: "Hello" }]);
    await delay(0);
    agent.continueConversation();
    const stream1 = await mockClient.awaitStream();
    stream1.streamText("Response 1");
    stream1.finishResponse("end_turn");
    await stream1.finalMessage();
    await delay(0);

    agent.appendUserMessage([{ type: "text", text: "Follow up" }]);
    await delay(0);
    agent.continueConversation();
    const stream2 = await mockClient.awaitStream();
    stream2.streamText("Response 2");
    stream2.finishResponse("end_turn");
    await stream2.finalMessage();
    await delay(0);

    // Before compaction: 4 messages
    expect(agent.getState().messages).toHaveLength(4);

    // Compact the entire thread
    agent.compact({ summary: "Summary of the conversation" });
    await delay(0);

    const state = agent.getState();
    // Should have just the summary as an assistant message
    expect(state.messages.length).toBe(1);
    expect(state.messages[0].role).toBe("assistant");
    expect(state.messages[0].content[0]).toEqual({
      type: "text",
      text: "Summary of the conversation",
    });
  });

  it("truncates to truncateIdx before compacting when provided", async () => {
    const mockClient = new MockAnthropicClient();
    const agent = createAgent(mockClient);

    // First exchange
    agent.appendUserMessage([{ type: "text", text: "First message" }]);
    await delay(0);
    agent.continueConversation();
    const stream1 = await mockClient.awaitStream();
    stream1.streamText("Response 1");
    stream1.finishResponse("end_turn");
    await stream1.finalMessage();
    await delay(0);

    // Second exchange
    agent.appendUserMessage([{ type: "text", text: "Second message" }]);
    await delay(0);
    agent.continueConversation();
    const stream2 = await mockClient.awaitStream();
    stream2.streamText("Response 2");
    stream2.finishResponse("end_turn");
    await stream2.finalMessage();
    await delay(0);

    // Capture truncate point
    const truncateIdx = agent.getNativeMessageIdx();

    // Third exchange (simulating @compact request)
    agent.appendUserMessage([{ type: "text", text: "Compact request" }]);
    await delay(0);
    agent.continueConversation();
    const stream3 = await mockClient.awaitStream();
    stream3.streamText("I will compact");
    stream3.finishResponse("end_turn");
    await stream3.finalMessage();
    await delay(0);

    // Before compaction: 6 messages
    expect(agent.getState().messages).toHaveLength(6);

    // Compact with truncateIdx to remove the @compact request
    agent.compact({ summary: "Summary of conversation" }, truncateIdx);
    await delay(0);

    const state = agent.getState();

    // The @compact request and response should be removed
    const hasCompactRequest = state.messages.some(
      (m) =>
        m.role === "user" &&
        m.content.some(
          (c) => c.type === "text" && c.text === "Compact request",
        ),
    );
    expect(hasCompactRequest).toBe(false);

    // Should have the summary
    const hasSummary = state.messages.some(
      (m) =>
        m.role === "assistant" &&
        m.content.some(
          (c) => c.type === "text" && c.text === "Summary of conversation",
        ),
    );
    expect(hasSummary).toBe(true);
  });

  it("handles empty summary", async () => {
    const mockClient = new MockAnthropicClient();
    const agent = createAgent(mockClient);

    agent.appendUserMessage([{ type: "text", text: "Hello" }]);
    await delay(0);
    agent.continueConversation();
    const stream1 = await mockClient.awaitStream();
    stream1.streamText("Response");
    stream1.finishResponse("end_turn");
    await stream1.finalMessage();
    await delay(0);

    // Compact with empty summary
    agent.compact({ summary: "" });
    await delay(0);

    const state = agent.getState();
    // Should have no messages (empty summary means empty message array)
    expect(state.messages.length).toBe(0);
  });

  it("trims compact tool_use when no truncateIdx provided", async () => {
    // This test was for the old agent-initiated compact tool which has been removed.
    // The compact flow now always uses the EDL-based compact subagent.
    // The trimCompactToolUse() method is dead code but kept for safety.
  });

  it("sets status to stopped/end_turn after compact", async () => {
    const mockClient = new MockAnthropicClient();
    const agent = createAgent(mockClient);

    agent.appendUserMessage([{ type: "text", text: "Hello" }]);
    await delay(0);
    agent.continueConversation();
    const stream1 = await mockClient.awaitStream();
    stream1.streamText("Response");
    stream1.finishResponse("end_turn");
    await stream1.finalMessage();
    await delay(0);

    agent.compact({ summary: "Summary" });
    await delay(0);

    const state = agent.getState();
    expect(state.status).toEqual({ type: "stopped", stopReason: "end_turn" });
  });
});

describe("clone", () => {
  it("creates a deep copy of the agent with all messages", async () => {
    const mockClient = new MockAnthropicClient();
    const tracked = trackMessages();
    const agent = createAgent(mockClient, undefined, tracked);

    // Build up some conversation history
    agent.appendUserMessage([{ type: "text", text: "Hello" }]);
    agent.continueConversation();

    const stream = await mockClient.awaitStream();
    stream.streamText("Hi there!");
    stream.finishResponse("end_turn");
    await stream.finalMessage();
    await delay(0);

    agent.appendUserMessage([{ type: "text", text: "How are you?" }]);
    agent.continueConversation();

    const stream2 = await mockClient.awaitStream();
    stream2.streamText("I'm doing well!");
    stream2.finishResponse("end_turn");
    await stream2.finalMessage();
    await delay(0);

    // Clone the agent
    const clonedTracked = trackMessages();
    const cloned = agent.clone((msg) => clonedTracked.messages.push(msg));

    // Verify cloned agent has same messages
    expect(cloned.getState().messages).toHaveLength(4);
    expect(cloned.getState().messages[0].role).toBe("user");
    expect(cloned.getState().messages[1].role).toBe("assistant");
    expect(cloned.getState().messages[2].role).toBe("user");
    expect(cloned.getState().messages[3].role).toBe("assistant");

    // Verify content is copied
    const clonedState = cloned.getState();
    expect(clonedState.messages[0].content[0]).toEqual({
      type: "text",
      text: "Hello",
    });
    expect(clonedState.messages[1].content[0]).toEqual({
      type: "text",
      text: "Hi there!",
    });
  });

  it("creates independent copy - changes to original don't affect clone", async () => {
    const mockClient = new MockAnthropicClient();
    const agent = createAgent(mockClient);

    agent.appendUserMessage([{ type: "text", text: "Hello" }]);
    agent.continueConversation();

    const stream = await mockClient.awaitStream();
    stream.streamText("Hi!");
    stream.finishResponse("end_turn");
    await stream.finalMessage();
    await delay(0);

    // Clone the agent
    const cloned = agent.clone(() => {});

    // Add more messages to original
    agent.appendUserMessage([{ type: "text", text: "Another message" }]);
    await delay(0);

    // Clone should not be affected
    expect(agent.getState().messages).toHaveLength(3);
    expect(cloned.getState().messages).toHaveLength(2);
  });

  it("clone while streaming with only a partial text block drops the empty assistant message", async () => {
    const mockClient = new MockAnthropicClient();
    const agent = createAgent(mockClient);

    agent.appendUserMessage([{ type: "text", text: "Hello" }]);
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
    const cloned = agent.clone(() => {});
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

    agent.appendUserMessage([{ type: "text", text: "Hello" }]);
    agent.continueConversation();

    const stream = await mockClient.awaitStream();

    // Finalize a text block
    stream.streamText("Complete text");

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
      },
    });

    // Clone while tool_use is in-progress (in currentAnthropicBlock)
    const cloned = agent.clone(() => {});
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

    agent.appendUserMessage([{ type: "text", text: "Search for something" }]);
    agent.continueConversation();

    const stream = await mockClient.awaitStream();

    // Finalize a server_tool_use block
    stream.streamServerToolUse("server-tool-1", "web_search", {
      query: "test query",
    });

    expect(agent.getState().status.type).toBe("streaming");

    // Clone — server_tool_use should be dropped, leaving empty assistant → removed
    const cloned = agent.clone(() => {});
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

    agent.appendUserMessage([{ type: "text", text: "Use a tool" }]);
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
    const cloned = agent.clone((msg) => clonedTracked.messages.push(msg));
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
    expect(clonedState.messages[2].content[0]).toEqual({
      type: "tool_result",
      id: "tool-req-1",
      result: {
        status: "error",
        error: "The thread was forked before the tool could execute.",
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

    agent.appendUserMessage([{ type: "text", text: "Hello" }]);
    agent.continueConversation();

    const stream = await mockClient.awaitStream();
    stream.streamText("First part");

    // Clone mid-stream
    const cloned = agent.clone(() => {});

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

    agent.appendUserMessage([{ type: "text", text: "Hello" }]);
    agent.continueConversation();

    const stream = await mockClient.awaitStream();
    stream.streamText("Hi!");
    stream.finishResponse("end_turn");
    await stream.finalMessage();
    await delay(0);

    // Clone the agent
    const cloned = agent.clone(() => {});

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

    agent.appendUserMessage([{ type: "text", text: "Hello" }]);
    agent.continueConversation();

    const stream = await mockClient.awaitStream();
    stream.streamText("Hi!");
    stream.finishResponse("end_turn");
    await stream.finalMessage();
    await delay(0);

    // Clone the agent
    const cloned = agent.clone(() => {});

    // Append message to cloned agent (without streaming)
    cloned.appendUserMessage([{ type: "text", text: "From clone" }]);
    await delay(0);

    // Cloned agent has the new message
    expect(cloned.getState().messages).toHaveLength(3);
    expect(cloned.getState().messages[2].content[0]).toEqual({
      type: "text",
      text: "From clone",
    });

    // Original is unchanged
    expect(agent.getState().messages).toHaveLength(2);
  });
});
