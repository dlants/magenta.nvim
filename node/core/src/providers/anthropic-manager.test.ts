import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import type { Agent, ToolExecutor } from "../agent.ts";
import type { Logger } from "../logger.ts";
import type { ProviderProfile } from "../provider-options.ts";
import { createTestAgent, flatPhase, noopLogger } from "../test-helpers.ts";
import type { ToolName, ToolRequestId } from "../tool-types.ts";
import { delay, pollUntil } from "../utils/async.ts";
import {
  ABORT_MARKER_TEXT,
  type AnthropicInferenceManager,
} from "./anthropic-runner.ts";
import { MockAnthropicClient } from "./mock-anthropic-client.ts";
import type {
  AgentInput,
  NativeMessageIdx,
  RequestedTool,
  StreamingBlock,
  ToolResults,
  TurnResult,
} from "./provider-types.ts";
import { PLACEHOLDER_NATIVE_MESSAGE_IDX } from "./provider-types.ts";

/** A thin adapter onto the real `Agent`: these tests are about what the
 * manager puts on the wire, but the loop driving it must be the production
 * one, so nothing here reimplements it. */
class TestAgent {
  constructor(
    readonly agent: Agent,
    private makeClone: (from: Agent) => TestAgent,
  ) {}

  get manager(): AnthropicInferenceManager {
    return this.agent.manager as AnthropicInferenceManager;
  }

  get log() {
    return this.agent.manager.log;
  }

  get phase(): ReturnType<typeof flatPhase> {
    return flatPhase(this.agent);
  }

  truncateMessages(idx: NativeMessageIdx): void {
    this.agent.manager.truncateMessages(idx);
  }

  clone(): TestAgent {
    return this.makeClone(this.agent);
  }

  abort(): void {
    void this.agent.abort();
  }

  runTurn(input: AgentInput[]): Promise<TurnResult> {
    return this.agent.runTurnLoop(input);
  }
}

/** Counts `onUpdate` notifications, which is all the agent emits now. */
type Tracked = { updates: number };

function trackUpdates(): Tracked {
  return { updates: 0 };
}

/** Default executor: no test reaches it unless it streams a tool_use. */
const rejectingExecutor: ToolExecutor = () =>
  Promise.reject(new Error("unexpected tool execution"));

type CreateOptions = {
  model?: string;
  executeTools?: ToolExecutor;
  logger?: Logger;
  thinking?: {
    enabled: boolean;
    budgetTokens?: number;
    displayThinking?: boolean;
    effort?: "low" | "medium" | "high" | "xhigh" | "max";
  };
};

function agentOptions(opts: CreateOptions, mockClient: MockAnthropicClient) {
  return {
    mockClient,
    executeTools: opts.executeTools ?? rejectingExecutor,
    anthropicOptions: {
      includeWebSearch: true,
      logger: opts.logger ?? noopLogger,
    },
    context: {
      profile: {
        provider: "mock",
        model: opts.model ?? "claude-sonnet-4-20250514",
        ...(opts.thinking ? { thinking: opts.thinking } : {}),
      } as ProviderProfile,
    },
  };
}

function createAgent(
  mockClient: MockAnthropicClient,
  options?: CreateOptions,
  tracked?: Tracked,
): TestAgent {
  const opts = options ?? {};
  const wrap = (agent: Agent): TestAgent =>
    new TestAgent(agent, (from) =>
      wrap(
        createTestAgent({
          ...agentOptions(opts, mockClient),
          cloneFrom: from.manager,
        }).agent,
      ),
    );
  return wrap(
    createTestAgent({
      ...agentOptions(opts, mockClient),
      ...(tracked
        ? {
            onUpdate: () => {
              tracked.updates++;
            },
          }
        : {}),
    }).agent,
  );
}

function streamingBlock(agent: TestAgent): StreamingBlock | undefined {
  const phase = agent.phase;
  return phase.type === "streaming" ? phase.block : undefined;
}

/** Wait for the agent to open a *new* stream, past the ones already seen. */
function awaitNextStream(mockClient: MockAnthropicClient, seen: number) {
  return pollUntil(() => {
    const stream = mockClient.streams[seen];
    if (!stream) throw new Error("No new stream yet");
    return stream;
  });
}

function okResults(
  requests: ReadonlyArray<RequestedTool>,
  text = "Tool output",
): ToolResults {
  return new Map(
    requests.map((r) => [
      r.id,
      {
        status: "ok" as const,
        value: [
          {
            type: "text" as const,
            text,
            nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
          },
        ],
        structuredResult: { toolName: "get_files" as ToolName },
      },
    ]),
  );
}

describe("thinking.effort", () => {
  it("includes output_config.effort on adaptive-thinking models", async () => {
    const mockClient = new MockAnthropicClient();
    const agent = createAgent(mockClient, {
      model: "claude-opus-4-7",
      thinking: { enabled: true, effort: "max" },
    });

    const turn = agent.runTurn([
      {
        type: "text",
        text: "Hi",
        nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
      },
    ]);

    const stream = await mockClient.awaitStream();

    expect(stream.params.output_config?.effort).toBe("max");
    expect(stream.params.thinking).toEqual({
      type: "adaptive",
      display: "omitted",
    });

    stream.finishResponse("end_turn");
    await stream.finalMessage();
    await turn;
  });

  it("drops effort and warns on non-adaptive-thinking models", async () => {
    const mockClient = new MockAnthropicClient();
    const warnings: string[] = [];
    const logger: Logger = {
      ...noopLogger,
      warn: (msg: string) => {
        warnings.push(msg);
      },
    } as Logger;
    const agent = createAgent(mockClient, {
      model: "claude-sonnet-4-5",
      thinking: { enabled: true, effort: "max" },
      logger,
    });

    const turn = agent.runTurn([
      {
        type: "text",
        text: "Hi",
        nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
      },
    ]);

    const stream = await mockClient.awaitStream();

    expect(stream.params.output_config).toBeUndefined();
    expect(
      warnings.some((w) => w.includes("thinking.effort is only supported")),
    ).toBe(true);

    stream.finishResponse("end_turn");
    await stream.finalMessage();
    await turn;
  });
});

describe("user input", () => {
  it("does not add assistant message until first content block completes", async () => {
    const mockClient = new MockAnthropicClient();
    const agent = createAgent(mockClient);

    const turn = agent.runTurn([
      {
        type: "text",
        text: "Hello",
        nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
      },
    ]);

    const stream = await mockClient.awaitStream();

    // Before any content blocks, should only have user message
    expect(agent.log.messages).toHaveLength(1);
    expect(agent.log.messages[0].role).toBe("user");

    // Start a text block
    const blockIndex = stream.nextBlockIndex();
    stream.emitEvent({
      type: "content_block_start",
      index: blockIndex,
      content_block: { type: "text", text: "", citations: null },
    });
    await stream.settle();

    // Still only user message - assistant message not added yet
    expect(agent.log.messages).toHaveLength(1);

    // Add some text delta
    stream.emitEvent({
      type: "content_block_delta",
      index: blockIndex,
      delta: { type: "text_delta", text: "Hello world" },
    });
    await stream.settle();

    // Still only user message
    expect(agent.log.messages).toHaveLength(1);

    // Complete the block
    stream.emitEvent({
      type: "content_block_stop",
      index: blockIndex,
    });
    await stream.settle();

    // Now assistant message should be added
    expect(agent.log.messages).toHaveLength(2);
    expect(agent.log.messages[1].role).toBe("assistant");
    expect(agent.log.messages[1].content).toHaveLength(1);

    stream.finishResponse("end_turn");
    await stream.finalMessage();
    await turn;
  });

  it("appends text input and notifies asynchronously", async () => {
    const mockClient = new MockAnthropicClient();
    const tracked = trackUpdates();
    const agent = createAgent(mockClient, undefined, tracked);

    const content: AgentInput[] = [
      {
        type: "text",
        text: "Hello, world!",
        nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
      },
    ];
    const turn = agent.runTurn(content);
    // The loop appends the caller's content after consulting the gate,
    // so wait for the request it produced before reading the log.
    await mockClient.awaitStream();
    const state = agent.log;
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].role).toBe("user");
    expect(state.messages[0].content).toHaveLength(1);
    expect(state.messages[0].content[0]).toMatchObject({
      type: "text",
      text: "Hello, world!",
    });

    await delay(0);
    expect(tracked.updates).toBeGreaterThan(0);

    const stream = await mockClient.awaitStream();
    stream.finishResponse("end_turn");
    await turn;
  });

  it("appends image input correctly", async () => {
    const mockClient = new MockAnthropicClient();
    const agent = createAgent(mockClient);

    const turn = agent.runTurn([
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: "base64data",
        },
        nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
      },
    ]);
    await mockClient.awaitStream();
    expect(agent.log.messages[0].content[0]).toMatchObject({
      type: "image",
      source: {
        type: "base64",
        media_type: "image/png",
        data: "base64data",
      },
    });

    const stream = await mockClient.awaitStream();
    stream.finishResponse("end_turn");
    await turn;
  });

  it("appends document input correctly", async () => {
    const mockClient = new MockAnthropicClient();
    const agent = createAgent(mockClient);

    const turn = agent.runTurn([
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
    ]);
    await mockClient.awaitStream();
    expect(agent.log.messages[0].content[0]).toMatchObject({
      type: "document",
      source: {
        type: "base64",
        media_type: "application/pdf",
        data: "pdfdata",
      },
      title: "My Document",
    });

    const stream = await mockClient.awaitStream();
    stream.finishResponse("end_turn");
    await turn;
  });
});

describe("tool execution", () => {
  it("appends the executor's results and continues the turn", async () => {
    const mockClient = new MockAnthropicClient();
    const toolUseId = "tool-123" as ToolRequestId;
    let seen: ReadonlyArray<RequestedTool> = [];
    const agent = createAgent(mockClient, {
      executeTools: (requests) => {
        seen = requests;
        return Promise.resolve({
          type: "continue" as const,
          results: okResults(requests),
        });
      },
    });

    const turn = agent.runTurn([
      {
        type: "text",
        text: "Hello",
        nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
      },
    ]);

    const stream = await mockClient.awaitStream();
    stream.streamToolUse(toolUseId, "get_files" as ToolName, {
      files: [{ filePath: "test.ts" }],
    });
    stream.finishResponse("tool_use");

    const stream2 = await awaitNextStream(mockClient, 1);
    expect(seen.map((r) => r.id)).toEqual([toolUseId]);

    const state = agent.log;
    expect(state.messages).toHaveLength(3);
    expect(state.messages[2].role).toBe("user");
    expect(state.messages[2].content[0].type).toBe("tool_result");

    stream2.streamText("Done.");
    stream2.finishResponse("end_turn");
    expect(await turn).toEqual({ type: "stopped", stopReason: "end_turn" });
  });

  it("fills an error result for any id the executor omits", async () => {
    const mockClient = new MockAnthropicClient();
    const toolUseId = "tool-omitted" as ToolRequestId;
    const agent = createAgent(mockClient, {
      executeTools: () =>
        Promise.resolve({ type: "suspend" as const, results: new Map() }),
    });

    const turn = agent.runTurn([
      {
        type: "text",
        text: "Hello",
        nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
      },
    ]);

    const stream = await mockClient.awaitStream();
    stream.streamToolUse(toolUseId, "get_files" as ToolName, {
      files: [{ filePath: "test.ts" }],
    });
    stream.finishResponse("tool_use");

    expect(await turn).toEqual({ type: "suspended" });

    const toolResult = agent.log.messages[2].content[0];
    expect(toolResult).toMatchObject({
      type: "tool_result",
      id: toolUseId,
      result: { status: "error" },
    });
  });

  it("fills error results when the executor rejects", async () => {
    const mockClient = new MockAnthropicClient();
    const toolUseId = "tool-reject" as ToolRequestId;
    const agent = createAgent(mockClient, {
      executeTools: () => Promise.reject(new Error("executor blew up")),
    });

    const turn = agent.runTurn([
      {
        type: "text",
        text: "Hello",
        nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
      },
    ]);

    const stream = await mockClient.awaitStream();
    stream.streamToolUse(toolUseId, "get_files" as ToolName, {
      files: [{ filePath: "test.ts" }],
    });
    stream.finishResponse("tool_use");

    const stream2 = await awaitNextStream(mockClient, 1);
    expect(agent.log.messages[2].content[0]).toMatchObject({
      type: "tool_result",
      id: toolUseId,
      result: { status: "error" },
    });

    stream2.finishResponse("end_turn");
    expect(await turn).toEqual({ type: "stopped", stopReason: "end_turn" });
  });
});

describe("runTurn", () => {
  it("rejects when a turn is already in flight", async () => {
    const mockClient = new MockAnthropicClient();
    const agent = createAgent(mockClient);

    const turn = agent.runTurn([
      {
        type: "text",
        text: "Hello",
        nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
      },
    ]);
    const stream = await mockClient.awaitStream();

    await expect(
      agent.runTurn([
        {
          type: "text",
          text: "Again",
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
        },
      ]),
    ).rejects.toThrow("already in flight");

    // State is unperturbed: the second input was never appended.
    expect(agent.log.messages).toHaveLength(1);

    stream.finishResponse("end_turn");
    await turn;
  });
});

describe("onUpdate", () => {
  it("notifies while the stream updates state", async () => {
    const mockClient = new MockAnthropicClient();
    const tracked = trackUpdates();
    const agent = createAgent(mockClient, undefined, tracked);

    const turn = agent.runTurn([
      {
        type: "text",
        text: "Test",
        nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
      },
    ]);
    await delay(0);
    expect(tracked.updates).toBeGreaterThan(0);

    const stream = await mockClient.awaitStream();
    const beforeStreaming = tracked.updates;
    stream.streamText("Hello");
    // The agent throttles its notifications, so a microtask is not enough.
    await delay(50);
    expect(tracked.updates).toBeGreaterThan(beforeStreaming);

    const beforeStop = tracked.updates;
    stream.finishResponse("end_turn");
    expect(await turn).toEqual({ type: "stopped", stopReason: "end_turn" });
    await delay(0);
    expect(tracked.updates).toBeGreaterThan(beforeStop);
  });
});

describe("abort", () => {
  it("does nothing when no turn is in flight", async () => {
    const mockClient = new MockAnthropicClient();
    const agent = createAgent(mockClient);
    agent.abort();
    await delay(0);
    expect(agent.phase).toEqual({ type: "idle" });
    expect(agent.log.messages).toEqual([]);
    expect(mockClient.streams).toEqual([]);
  });
  it("resolves the turn as aborted when the stream is active", async () => {
    const mockClient = new MockAnthropicClient();
    const agent = createAgent(mockClient);

    const turn = agent.runTurn([
      {
        type: "text",
        text: "Hello",
        nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
      },
    ]);

    const stream = await mockClient.awaitStream();
    stream.streamText("Partial response");

    agent.abort();

    expect(await turn).toEqual({ type: "aborted" });
    expect(agent.phase).toEqual({ type: "idle" });
  });

  it("adds tool_result with abort message when aborting during tool_use", async () => {
    const mockClient = new MockAnthropicClient();
    const agent = createAgent(mockClient);

    const turn = agent.runTurn([
      {
        type: "text",
        text: "Hello",
        nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
      },
    ]);

    const stream = await mockClient.awaitStream();

    // Stream a tool_use block but don't finish the response
    const toolUseId = "tool-abort-test" as ToolRequestId;
    stream.streamToolUse(toolUseId, "get_files" as ToolName, {
      files: [{ filePath: "test.ts" }],
    });

    // Abort while tool_use is the last block
    agent.abort();

    await new Promise((resolve) => setTimeout(resolve, 0));

    const state = agent.log;

    // user message, assistant with tool_use, user with tool_result, abort marker
    expect(state.messages).toHaveLength(4);
    expect(state.messages[2].role).toBe("user");
    expect(state.messages[3].content[0]).toMatchObject({
      type: "text",
      text: ABORT_MARKER_TEXT,
    });

    const toolResult = state.messages[2].content[0];
    expect(toolResult.type).toBe("tool_result");
    if (toolResult.type === "tool_result") {
      expect(toolResult.id).toBe(toolUseId);
      expect(toolResult.result.status).toBe("error");
      if (toolResult.result.status === "error") {
        expect(toolResult.result.error).toContain("aborted");
      }
    }
    await turn;
  });

  it("removes server_tool_use block when aborting during web search", async () => {
    const mockClient = new MockAnthropicClient();
    const agent = createAgent(mockClient);

    const turn = agent.runTurn([
      {
        type: "text",
        text: "Search for info",
        nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
      },
    ]);

    const stream = await mockClient.awaitStream();

    // Stream some text first
    stream.streamText("Let me search for that.");

    // Stream a server_tool_use block (web search)
    stream.streamServerToolUse("server-tool-1", "web_search", {
      query: "test query",
    });

    // Abort while waiting for web search results
    agent.abort();

    await new Promise((resolve) => setTimeout(resolve, 0));

    const state = agent.log;

    // user message, assistant with just text (server_tool_use removed), abort marker
    expect(state.messages).toHaveLength(3);
    expect(state.messages[1].role).toBe("assistant");
    expect(state.messages[1].content).toHaveLength(1);
    expect(state.messages[1].content[0].type).toBe("text");
    await turn;
  });
});

describe("abort with empty blocks", () => {
  it("removes empty text block when aborting before any text deltas", async () => {
    const mockClient = new MockAnthropicClient();
    const agent = createAgent(mockClient);

    const turn = agent.runTurn([
      {
        type: "text",
        text: "Hello",
        nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
      },
    ]);

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
    await stream.settle();
    agent.abort();
    expect(await turn).toEqual({ type: "aborted" });

    const state = agent.log;
    // The empty text block is filtered out, leaving the user message and the
    // abort marker
    expect(state.messages).toHaveLength(2);
    expect(state.messages[0].role).toBe("user");
  });

  it("removes empty thinking block when aborting before any thinking deltas", async () => {
    const mockClient = new MockAnthropicClient();
    const agent = createAgent(mockClient);

    const turn = agent.runTurn([
      {
        type: "text",
        text: "Hello",
        nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
      },
    ]);

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

    await stream.settle();
    agent.abort();
    expect(await turn).toEqual({ type: "aborted" });

    const state = agent.log;
    // The empty thinking block should be filtered out
    expect(state.messages).toHaveLength(2);
    expect(state.messages[0].role).toBe("user");
  });

  it("keeps non-empty blocks and removes empty ones when aborting", async () => {
    const mockClient = new MockAnthropicClient();
    const agent = createAgent(mockClient);

    const turn = agent.runTurn([
      {
        type: "text",
        text: "Hello",
        nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
      },
    ]);

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

    await stream.settle();
    agent.abort();
    expect(await turn).toEqual({ type: "aborted" });

    const state = agent.log;
    // Should keep the thinking block but remove the empty text block
    expect(state.messages).toHaveLength(3);
    expect(state.messages[1].role).toBe("assistant");
    expect(state.messages[1].content).toHaveLength(1);
    expect(state.messages[1].content[0].type).toBe("thinking");
  });
});

describe("thinking blocks", () => {
  it("captures thinking content and signature during streaming", async () => {
    const mockClient = new MockAnthropicClient();
    const agent = createAgent(mockClient);

    const turn = agent.runTurn([
      {
        type: "text",
        text: "Hello",
        nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
      },
    ]);

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
    let block = streamingBlock(agent);
    expect(block).toBeDefined();
    expect(block?.type).toBe("thinking");

    // Add thinking content
    stream.emitEvent({
      type: "content_block_delta",
      index: blockIndex,
      delta: { type: "thinking_delta", thinking: "Let me think about this..." },
    });
    await stream.settle();

    block = streamingBlock(agent);
    expect(block?.type).toBe("thinking");
    if (block?.type === "thinking") {
      expect(block.thinking).toBe("Let me think about this...");
      expect(block.signature).toBe("");
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

    block = streamingBlock(agent);
    if (block?.type === "thinking") {
      expect(block.thinking).toBe("Let me think about this...");
      expect(block.signature).toBe("EqQBCgIYAhIM1gbcDa9GJwZA2b3h");
    }

    // Stop the block
    stream.emitEvent({
      type: "content_block_stop",
      index: blockIndex,
    });
    await stream.settle();

    expect(streamingBlock(agent)).toBeUndefined();

    // Check that the streamed content was captured in the message
    const state = agent.log;
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
    agent.abort();
    await turn;
  });

  it("accumulates signature across multiple deltas", async () => {
    const mockClient = new MockAnthropicClient();
    const agent = createAgent(mockClient);

    const turn = agent.runTurn([
      {
        type: "text",
        text: "Hello",
        nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
      },
    ]);

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

    const block = streamingBlock(agent);
    if (block?.type === "thinking") {
      expect(block.thinking).toBe("Part 1 Part 2");
      expect(block.signature).toBe("ABCDEF");
    }

    stream.emitEvent({
      type: "content_block_stop",
      index: blockIndex,
    });

    stream.finishResponse("end_turn");
    await stream.finalMessage();
    await turn;
  });

  it("uses streamThinking helper with signature", async () => {
    const mockClient = new MockAnthropicClient();
    const agent = createAgent(mockClient);

    const turn = agent.runTurn([
      {
        type: "text",
        text: "Hello",
        nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
      },
    ]);

    const stream = await mockClient.awaitStream();
    stream.streamThinking("Deep thoughts here", "signature123");
    stream.streamText("Here is my answer");
    stream.finishResponse("end_turn");

    await stream.finalMessage();
    await delay(0);

    const state = agent.log;
    expect(state.messages).toHaveLength(2);

    const assistantContent = state.messages[1].content;
    expect(assistantContent).toHaveLength(2);

    expect(assistantContent[0].type).toBe("thinking");
    if (assistantContent[0].type === "thinking") {
      expect(assistantContent[0].thinking).toBe("Deep thoughts here");
      expect(assistantContent[0].signature).toBe("signature123");
    }

    expect(assistantContent[1].type).toBe("text");
    await turn;
  });
});

describe("streaming block", () => {
  it("exposes text streaming block during streaming", async () => {
    const mockClient = new MockAnthropicClient();
    const agent = createAgent(mockClient);

    const turn = agent.runTurn([
      {
        type: "text",
        text: "Hello",
        nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
      },
    ]);

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
    let block = streamingBlock(agent);
    expect(block).toBeDefined();
    expect(block?.type).toBe("text");

    // Add some text
    stream.emitEvent({
      type: "content_block_delta",
      index: blockIndex,
      delta: { type: "text_delta", text: "Hello world" },
    });
    await stream.settle();

    block = streamingBlock(agent);
    expect(block?.type).toBe("text");
    if (block?.type === "text") {
      expect(block.text).toBe("Hello world");
    }

    // Stop the block
    stream.emitEvent({
      type: "content_block_stop",
      index: blockIndex,
    });
    await stream.settle();

    // Streaming block should be cleared
    expect(streamingBlock(agent)).toBeUndefined();

    // Clean up
    stream.finishResponse("end_turn");
    await stream.finalMessage();
    await turn;
  });

  it("exposes tool_use streaming block during streaming", async () => {
    const mockClient = new MockAnthropicClient();
    const agent = createAgent(mockClient, {
      executeTools: (requests) =>
        Promise.resolve({
          type: "suspend" as const,
          results: okResults(requests),
        }),
    });

    const turn = agent.runTurn([
      {
        type: "text",
        text: "Hello",
        nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
      },
    ]);

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
        name: "get_files",
        input: {},
        caller: { type: "direct" as const },
      },
    });
    await stream.settle();

    let block = streamingBlock(agent);
    expect(block?.type).toBe("tool_use");

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

    block = streamingBlock(agent);
    if (block?.type === "tool_use") {
      expect(block.inputJson).toBe('{"filePath":"test.ts"}');
    }

    // Stop the block
    stream.emitEvent({
      type: "content_block_stop",
      index: blockIndex,
    });
    await stream.settle();

    expect(streamingBlock(agent)).toBeUndefined();

    stream.finishResponse("tool_use");
    await stream.finalMessage();
    await turn;
  });

  it("returns undefined for server_tool_use blocks", async () => {
    const mockClient = new MockAnthropicClient();
    const agent = createAgent(mockClient);

    const turn = agent.runTurn([
      {
        type: "text",
        text: "Search",
        nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
      },
    ]);

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
    expect(streamingBlock(agent)).toBeUndefined();

    stream.emitEvent({
      type: "content_block_stop",
      index: blockIndex,
    });

    stream.finishResponse("end_turn");
    await stream.finalMessage();
    await turn;
  });

  it("dispatches content-updated messages during streaming", async () => {
    const mockClient = new MockAnthropicClient();
    const tracked = trackUpdates();
    const agent = createAgent(mockClient, undefined, tracked);

    const turn = agent.runTurn([
      {
        type: "text",
        text: "Hello",
        nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
      },
    ]);

    const stream = await mockClient.awaitStream();

    // Count updates after initial events
    await delay(0);
    const initialCount = tracked.updates;

    stream.streamText("Hello world");
    await delay(0);

    // Streaming should have produced further update notifications
    await delay(50);
    expect(tracked.updates).toBeGreaterThan(initialCount);

    stream.finishResponse("end_turn");
    await turn;
  });
});

describe("web search result preservation", () => {
  it("preserves encrypted_content in web_search_tool_result after stream completes", async () => {
    const mockClient = new MockAnthropicClient();
    const agent = createAgent(mockClient);

    const turn = agent.runTurn([
      {
        type: "text",
        text: "Search for Claude Shannon",
        nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
      },
    ]);

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

    const state = agent.log;
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
    await turn;
  });

  it("preserves web_search_tool_result in native messages for next turn", async () => {
    const mockClient = new MockAnthropicClient();
    const agent = createAgent(mockClient);

    const turn = agent.runTurn([
      {
        type: "text",
        text: "Search for info",
        nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
      },
    ]);

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
    const turn2 = agent.runTurn([
      {
        type: "text",
        text: "Tell me more",
        nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
      },
    ]);

    // Check that the native messages sent to the API contain the web search result
    const stream2 = await awaitNextStream(mockClient, 1);
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
    await turn2;
    await turn;
  });

  describe("error handling with cleanup", () => {
    it("adds tool_result with error message when stream errors during tool_use", async () => {
      const mockClient = new MockAnthropicClient();
      const agent = createAgent(mockClient);

      const turn = agent.runTurn([
        {
          type: "text",
          text: "Hello",
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
        },
      ]);

      const stream = await mockClient.awaitStream();

      // Stream a tool_use block
      const toolUseId = "tool-error-test" as ToolRequestId;
      stream.streamToolUse(toolUseId, "get_files" as ToolName, {
        files: [{ filePath: "test.ts" }],
      });
      await stream.settle();

      // Simulate a stream error
      stream.respondWithError(new Error("Connection lost"));

      const result = await turn;
      const state = agent.log;

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

      expect(result.type).toBe("failed");
    });

    it("removes server_tool_use block when stream errors during web search", async () => {
      const mockClient = new MockAnthropicClient();
      const agent = createAgent(mockClient);

      const turn = agent.runTurn([
        {
          type: "text",
          text: "Search for info",
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
        },
      ]);

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

      const result = await turn;
      const state = agent.log;

      // Should have: user message, assistant with just text (server_tool_use removed)
      expect(state.messages).toHaveLength(2);
      expect(state.messages[1].role).toBe("assistant");
      expect(state.messages[1].content).toHaveLength(1);
      expect(state.messages[1].content[0].type).toBe("text");

      expect(result.type).toBe("failed");
    });
  });

  describe("latestUsage", () => {
    it("tracks usage from successful responses", async () => {
      const mockClient = new MockAnthropicClient();
      const agent = createAgent(mockClient);

      const turn = agent.runTurn([
        {
          type: "text",
          text: "Hello",
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
        },
      ]);

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

      const state = agent.log;
      expect(state.latestUsage).toEqual({
        inputTokens: 100,
        outputTokens: 50,
        cacheHits: 10,
        cacheMisses: 5,
      });
      await turn;
    });

    it("preserves latestUsage when subsequent request is aborted", async () => {
      const mockClient = new MockAnthropicClient();
      const agent = createAgent(mockClient);

      // First request - successful
      const turn = agent.runTurn([
        {
          type: "text",
          text: "Hello",
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
        },
      ]);

      const stream1 = await mockClient.awaitStream();
      stream1.streamText("Hello there!");
      stream1.finishResponse("end_turn", {
        inputTokens: 100,
        outputTokens: 50,
      });

      await stream1.finalMessage();
      await delay(0);

      // Verify initial usage
      expect(agent.log.latestUsage).toEqual({
        inputTokens: 100,
        outputTokens: 50,
      });

      // Second request - will be aborted
      const turn2 = agent.runTurn([
        {
          type: "text",
          text: "Follow up",
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
        },
      ]);

      const stream2 = await awaitNextStream(mockClient, 1);
      stream2.streamText("Starting to respond...");

      // Abort the second request
      agent.abort();
      expect(await turn2).toEqual({ type: "aborted" });

      // latestUsage should still reflect the first successful request
      const state = agent.log;
      expect(state.latestUsage).toEqual({
        inputTokens: 100,
        outputTokens: 50,
      });
      await turn;
    });

    it("preserves latestUsage when subsequent request errors", async () => {
      const mockClient = new MockAnthropicClient();
      const agent = createAgent(mockClient);

      // First request - successful
      const turn = agent.runTurn([
        {
          type: "text",
          text: "Hello",
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
        },
      ]);

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
      expect(agent.log.latestUsage).toEqual({
        inputTokens: 200,
        outputTokens: 75,
        cacheHits: 20,
      });

      // Second request - will error
      const turn2 = agent.runTurn([
        {
          type: "text",
          text: "Follow up",
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
        },
      ]);

      const stream2 = await awaitNextStream(mockClient, 1);
      stream2.streamText("Starting to respond...");
      await stream2.settle();

      // Simulate an error
      stream2.respondWithError(new Error("Connection lost"));
      const result = await turn2;

      // latestUsage should still reflect the first successful request
      const state = agent.log;
      expect(result.type).toBe("failed");
      expect(state.latestUsage).toEqual({
        inputTokens: 200,
        outputTokens: 75,
        cacheHits: 20,
      });
      await turn;
    });

    it("updates latestUsage only on successful responses", async () => {
      const mockClient = new MockAnthropicClient();
      const agent = createAgent(mockClient);

      // Initially undefined
      expect(agent.log.latestUsage).toBeUndefined();

      // First request - abort (should not set latestUsage)
      const turn = agent.runTurn([
        {
          type: "text",
          text: "First",
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
        },
      ]);
      const stream1 = await mockClient.awaitStream();
      stream1.streamText("Partial...");
      agent.abort();
      expect(await turn).toEqual({ type: "aborted" });

      expect(agent.log.latestUsage).toBeUndefined();

      // Second request - successful (should set latestUsage)
      const turn2 = agent.runTurn([
        {
          type: "text",
          text: "Second",
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
        },
      ]);
      const stream2 = await awaitNextStream(mockClient, 1);
      stream2.streamText("Complete response");
      stream2.finishResponse("end_turn", {
        inputTokens: 150,
        outputTokens: 60,
      });

      await stream2.finalMessage();
      await delay(0);

      expect(agent.log.latestUsage).toEqual({
        inputTokens: 150,
        outputTokens: 60,
      });
      await turn2;
    });
  });

  describe("malformed tool_use handling", () => {
    it("produces error request for tool_use with invalid input", async () => {
      const mockClient = new MockAnthropicClient();
      const agent = createAgent(mockClient, {
        executeTools: (requests) =>
          Promise.resolve({
            type: "suspend" as const,
            results: okResults(requests),
          }),
      });

      const turn = agent.runTurn([
        {
          type: "text",
          text: "Hello",
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
        },
      ]);

      const stream = await mockClient.awaitStream();
      // Stream a tool_use with missing required field (filePath)
      stream.streamToolUse(
        "tool-malformed" as ToolRequestId,
        "get_files" as ToolName,
        {},
      );
      stream.finishResponse("tool_use");
      expect(await turn).toEqual({ type: "suspended" });

      const state = agent.log;
      const assistantContent = state.messages[1].content;
      const toolUseBlock = assistantContent.find((b) => b.type === "tool_use");
      expect(toolUseBlock).toBeDefined();
      if (toolUseBlock?.type === "tool_use") {
        expect(toolUseBlock.request.status).toBe("error");
      }
    });

    it("accepts an error tool_result for a malformed tool_use block", async () => {
      const mockClient = new MockAnthropicClient();
      const toolUseId = "tool-malformed" as ToolRequestId;
      const agent = createAgent(mockClient, {
        executeTools: () =>
          Promise.resolve({
            type: "continue" as const,
            results: new Map([
              [
                toolUseId,
                {
                  status: "error" as const,
                  error: "Malformed tool_use block: missing filePath",
                },
              ],
            ]),
          }),
      });

      const turn = agent.runTurn([
        {
          type: "text",
          text: "Hello",
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
        },
      ]);

      const stream = await mockClient.awaitStream();
      stream.streamToolUse(toolUseId, "get_files" as ToolName, {});
      stream.finishResponse("tool_use");

      // The conversation continues with the error result in place
      const stream2 = await awaitNextStream(mockClient, 1);
      const state = agent.log;
      expect(state.messages).toHaveLength(3);
      expect(state.messages[2].role).toBe("user");
      expect(state.messages[2].content[0].type).toBe("tool_result");

      stream2.streamText("OK, I'll fix that.");
      stream2.finishResponse("end_turn");
      expect(await turn).toEqual({ type: "stopped", stopReason: "end_turn" });

      expect(agent.log.messages).toHaveLength(4);
    });
  });

  describe("context_update detection", () => {
    it("converts text blocks with <context_update> tags to context_update type", async () => {
      const mockClient = new MockAnthropicClient();
      const agent = createAgent(mockClient);

      const contextUpdateText = `<context_update>
These files are part of your context.
File \`test.ts\`
const x = 1;
</context_update>`;

      const turn = agent.runTurn([
        {
          type: "text",
          text: contextUpdateText,
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
        },
      ]);

      await mockClient.awaitStream();
      const state = agent.log;
      expect(state.messages).toHaveLength(1);
      expect(state.messages[0].content[0].type).toBe("context_update");
      if (state.messages[0].content[0].type === "context_update") {
        expect(state.messages[0].content[0].text).toBe(contextUpdateText);
      }

      const stream = await mockClient.awaitStream();
      stream.finishResponse("end_turn");
      await turn;
    });

    it("does not convert regular text to context_update type", async () => {
      const mockClient = new MockAnthropicClient();
      const agent = createAgent(mockClient);

      const turn = agent.runTurn([
        {
          type: "text",
          text: "Hello, this is regular text",
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
        },
      ]);

      await mockClient.awaitStream();
      const state = agent.log;
      expect(state.messages[0].content[0].type).toBe("text");

      const stream = await mockClient.awaitStream();
      stream.finishResponse("end_turn");
      await turn;
    });

    it("converts context_update in multi-content messages correctly", async () => {
      const mockClient = new MockAnthropicClient();
      const agent = createAgent(mockClient);

      const contextUpdateText = `<context_update>
File context here
</context_update>`;

      const turn = agent.runTurn([
        {
          type: "text",
          text: contextUpdateText,
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
        },
        {
          type: "text",
          text: "Now here is my question",
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
        },
      ]);

      await mockClient.awaitStream();
      const state = agent.log;
      expect(state.messages).toHaveLength(1);
      expect(state.messages[0].content).toHaveLength(2);
      expect(state.messages[0].content[0].type).toBe("context_update");
      expect(state.messages[0].content[1].type).toBe("text");

      const stream = await mockClient.awaitStream();
      stream.finishResponse("end_turn");
      await turn;
    });
  });

  describe("clone", () => {
    it("creates a deep copy of the agent with all messages", async () => {
      const mockClient = new MockAnthropicClient();
      const tracked = trackUpdates();
      const agent = createAgent(mockClient, undefined, tracked);

      // Build up some conversation history
      const turn = agent.runTurn([
        {
          type: "text",
          text: "Hello",
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
        },
      ]);

      const stream = await mockClient.awaitStream();
      stream.streamText("Hi there!");
      stream.finishResponse("end_turn");
      await stream.finalMessage();
      await delay(0);

      const turn2 = agent.runTurn([
        {
          type: "text",
          text: "How are you?",
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
        },
      ]);

      const stream2 = await awaitNextStream(mockClient, 1);
      stream2.streamText("I'm doing well!");
      stream2.finishResponse("end_turn");
      await stream2.finalMessage();
      await delay(0);

      // Clone the agent
      const cloned = agent.clone();

      // Verify cloned agent has same messages
      expect(cloned.log.messages).toHaveLength(4);
      expect(cloned.log.messages[0].role).toBe("user");
      expect(cloned.log.messages[1].role).toBe("assistant");
      expect(cloned.log.messages[2].role).toBe("user");
      expect(cloned.log.messages[3].role).toBe("assistant");

      // Verify content is copied
      const clonedState = cloned.log;
      expect(clonedState.messages[0].content[0]).toMatchObject({
        type: "text",
        text: "Hello",
      });
      expect(clonedState.messages[1].content[0]).toMatchObject({
        type: "text",
        text: "Hi there!",
      });
      await turn;
      await turn2;
    });

    it("creates independent copy - changes to original don't affect clone", async () => {
      const mockClient = new MockAnthropicClient();
      const agent = createAgent(mockClient);

      const turn = agent.runTurn([
        {
          type: "text",
          text: "Hello",
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
        },
      ]);

      const stream = await mockClient.awaitStream();
      stream.streamText("Hi!");
      stream.finishResponse("end_turn");
      await stream.finalMessage();
      await delay(0);

      // Clone the agent
      const cloned = agent.clone();

      // Add more messages to original
      const turn2 = agent.runTurn([
        {
          type: "text",
          text: "Another message",
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
        },
      ]);
      await mockClient.awaitStream();

      // Clone should not be affected
      expect(agent.log.messages).toHaveLength(3);
      expect(cloned.log.messages).toHaveLength(2);

      agent.abort();
      await turn2;
      await turn;
    });

    it("clone while streaming with only a partial text block drops the empty assistant message", async () => {
      const mockClient = new MockAnthropicClient();
      const agent = createAgent(mockClient);

      const turn = agent.runTurn([
        {
          type: "text",
          text: "Hello",
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
        },
      ]);

      const stream = await mockClient.awaitStream();
      expect(agent.phase.type).toBe("streaming");

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
      const clonedState = cloned.log;

      // Only the user message should be present (no assistant message)
      expect(clonedState.messages).toHaveLength(1);
      expect(clonedState.messages[0].role).toBe("user");
      expect(cloned.phase).toEqual({ type: "idle" });

      // Clean up source
      stream.emitEvent({ type: "content_block_stop", index });
      stream.finishResponse("end_turn");
      await stream.finalMessage();
      await turn;
    });

    it("clone while streaming with finalized text and in-progress tool_use keeps the text", async () => {
      const mockClient = new MockAnthropicClient();
      const agent = createAgent(mockClient, {
        executeTools: (requests) =>
          Promise.resolve({
            type: "suspend" as const,
            results: okResults(requests),
          }),
      });

      const turn = agent.runTurn([
        {
          type: "text",
          text: "Hello",
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
        },
      ]);

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
          name: "get_files" as ToolName,
          input: {},
          caller: { type: "direct" as const },
        },
      });
      await stream.settle();

      // Clone while tool_use is in-progress (in currentAnthropicBlock)
      const cloned = agent.clone();
      const clonedState = cloned.log;

      // Should have user + assistant with just the finalized text
      expect(clonedState.messages[1].content).toHaveLength(1);
      expect(clonedState.messages[1].content[0].type).toBe("text");
      expect(clonedState.messages[1].content[0]).toHaveProperty(
        "text",
        "Complete text",
      );
      expect(cloned.phase).toEqual({ type: "idle" });

      // Clean up source
      stream.emitEvent({ type: "content_block_stop", index: toolIndex });
      stream.finishResponse("end_turn");
      await stream.finalMessage();
      await turn;
    });

    it("clone while streaming with finalized server_tool_use drops it", async () => {
      const mockClient = new MockAnthropicClient();
      const agent = createAgent(mockClient);

      const turn = agent.runTurn([
        {
          type: "text",
          text: "Search for something",
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
        },
      ]);

      const stream = await mockClient.awaitStream();

      // Finalize a server_tool_use block
      stream.streamServerToolUse("server-tool-1", "web_search", {
        query: "test query",
      });

      expect(agent.phase.type).toBe("streaming");

      // Clone — server_tool_use should be dropped, leaving empty assistant → removed
      const cloned = agent.clone();
      const clonedState = cloned.log;

      expect(clonedState.messages).toHaveLength(1);
      expect(clonedState.messages[0].role).toBe("user");
      expect(cloned.phase).toEqual({ type: "idle" });

      // Clean up source
      stream.finishResponse("end_turn");
      await stream.finalMessage();
      await turn;
    });

    it("clone while awaiting tool results adds error tool_results", async () => {
      const mockClient = new MockAnthropicClient();
      let onCalled!: () => void;
      const toolsCalled = new Promise<void>((resolve) => {
        onCalled = resolve;
      });
      let releaseTools!: () => void;
      const agent = createAgent(mockClient, {
        executeTools: (requests) => {
          onCalled();
          return new Promise((resolve) => {
            releaseTools = () =>
              resolve({ type: "suspend", results: okResults(requests) });
          });
        },
      });

      const turn = agent.runTurn([
        {
          type: "text",
          text: "Use a tool",
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
        },
      ]);

      const stream = await mockClient.awaitStream();
      stream.streamText("I'll use the tool.");
      stream.streamToolUse(
        "tool-req-1" as ToolRequestId,
        "get_files" as ToolName,
        { files: [{ filePath: "test.ts" }] },
      );
      stream.finishResponse("tool_use");

      // The executor is stalled, so the agent stays in running_tools
      await toolsCalled;
      expect(agent.phase).toMatchObject({
        type: "running_tools",
        requested: [{ id: "tool-req-1" }],
      });

      // Clone while the tool results are still outstanding
      const cloned = agent.clone();
      const clonedState = cloned.log;

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
        "get_files",
      );
      expect(clonedState.messages[2].role).toBe("user");
      expect(clonedState.messages[2].content).toHaveLength(1);
      expect(clonedState.messages[2].content[0]).toMatchObject({
        type: "tool_result",
        id: "tool-req-1",
        result: {
          status: "error",
          error: "The thread was forked before the tool could execute.",
        },
        nativeMessageIdx: 2 as NativeMessageIdx,
      });
      expect(cloned.phase).toEqual({ type: "idle" });

      // Source agent should be unchanged
      expect(agent.phase.type).toBe("running_tools");
      expect(agent.log.messages).toHaveLength(2);

      releaseTools();
      expect(await turn).toEqual({ type: "suspended" });
    });

    it("source agent continues streaming unaffected after clone", async () => {
      const mockClient = new MockAnthropicClient();
      const tracked = trackUpdates();
      const agent = createAgent(mockClient, undefined, tracked);

      const turn = agent.runTurn([
        {
          type: "text",
          text: "Hello",
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
        },
      ]);

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
      const sourceState = agent.log;
      expect(agent.phase).toEqual({ type: "idle" });
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
      const clonedState = cloned.log;
      expect(clonedState.messages).toHaveLength(2);
      expect(clonedState.messages[1].content).toHaveLength(1);
      expect(clonedState.messages[1].content[0]).toHaveProperty(
        "text",
        "First part",
      );
      await turn;
    });

    it("preserves stop info for messages", async () => {
      const mockClient = new MockAnthropicClient();
      const agent = createAgent(mockClient);

      const turn = agent.runTurn([
        {
          type: "text",
          text: "Hello",
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
        },
      ]);

      const stream = await mockClient.awaitStream();
      stream.streamText("Hi!");
      stream.finishResponse("end_turn");
      await stream.finalMessage();
      await delay(0);

      // Clone the agent
      const cloned = agent.clone();

      // Verify stop reason is preserved
      const clonedState = cloned.log;
      expect(clonedState.messages[1].stopReason).toBe("end_turn");
      expect(cloned.phase).toEqual({ type: "idle" });
      await turn;
    });

    it("cloned agent can append messages independently", async () => {
      const mockClient = new MockAnthropicClient();
      const agent = createAgent(mockClient);

      const turn = agent.runTurn([
        {
          type: "text",
          text: "Hello",
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
        },
      ]);

      const stream = await mockClient.awaitStream();
      stream.streamText("Hi!");
      stream.finishResponse("end_turn");
      await stream.finalMessage();
      await delay(0);

      // Clone the agent
      const cloned = agent.clone();

      // Start a turn on the clone; the input is appended immediately
      const clonedTurn = cloned.runTurn([
        {
          type: "text",
          text: "From clone",
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
        },
      ]);
      await mockClient.awaitStream();

      // Cloned agent has the new message
      expect(cloned.log.messages).toHaveLength(3);
      expect(cloned.log.messages[2].content[0]).toMatchObject({
        type: "text",
        text: "From clone",
      });

      // Original is unchanged
      expect(agent.log.messages).toHaveLength(2);

      cloned.abort();
      await clonedTurn;
      await turn;
    });
  });

  describe("truncateMessages", () => {
    it("truncates at an assistant text-only message keeping [0..N]", async () => {
      const mockClient = new MockAnthropicClient();
      const agent = createAgent(mockClient);

      const turn = agent.runTurn([
        {
          type: "text",
          text: "Q1",
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
        },
      ]);
      let stream = await mockClient.awaitStream();
      stream.streamText("A1");
      stream.finishResponse("end_turn");
      await turn;

      const turn2 = agent.runTurn([
        {
          type: "text",
          text: "Q2",
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
        },
      ]);
      stream = await awaitNextStream(mockClient, 1);
      stream.streamText("A2");
      stream.finishResponse("end_turn");
      await turn2;

      // messages: [user Q1, assistant A1, user Q2, assistant A2]
      const messageIdx = 1 as never;
      agent.truncateMessages(messageIdx);

      expect(agent.log.messages).toHaveLength(2);
      expect(agent.phase).toEqual({ type: "idle" });
    });

    it("truncates at assistant tool_use message and extends to keep tool_result", async () => {
      const mockClient = new MockAnthropicClient();
      const agent = createAgent(mockClient, {
        executeTools: (requests) =>
          Promise.resolve({
            type: "continue" as const,
            results: okResults(requests, "file contents"),
          }),
      });

      const turn = agent.runTurn([
        {
          type: "text",
          text: "Run tool",
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
        },
      ]);
      const stream = await mockClient.awaitStream();
      stream.streamText("Running...");
      stream.streamToolUse("tool-1" as ToolRequestId, "get_files" as ToolName, {
        files: [{ filePath: "x.ts" }],
      });
      stream.finishResponse("tool_use");

      const followup = await awaitNextStream(mockClient, 1);
      followup.streamText("Done.");
      followup.finishResponse("end_turn");
      expect(await turn).toEqual({ type: "stopped", stopReason: "end_turn" });

      // messages: [user Run, assistant w/tool_use, user tool_result, assistant Done]
      expect(agent.log.messages).toHaveLength(4);

      // Truncate at the assistant message that contains tool_use (idx=1).
      // Should extend to keep idx=2 (tool_result) too.
      agent.truncateMessages(1 as never);
      expect(agent.log.messages).toHaveLength(3);
      expect(agent.log.messages[1].role).toBe("assistant");
      expect(agent.log.messages[2].role).toBe("user");
    });

    it("drops orphan tool_use blocks when no matching tool_result follows", async () => {
      const mockClient = new MockAnthropicClient();
      let onCalled!: () => void;
      const toolsCalled = new Promise<void>((resolve) => {
        onCalled = resolve;
      });
      let releaseTools!: () => void;
      const agent = createAgent(mockClient, {
        executeTools: () => {
          onCalled();
          return new Promise((resolve) => {
            releaseTools = () =>
              resolve({ type: "aborted", results: new Map() });
          });
        },
      });

      const turn = agent.runTurn([
        {
          type: "text",
          text: "Run tool",
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
        },
      ]);
      const stream = await mockClient.awaitStream();
      stream.streamText("Running.");
      stream.streamToolUse(
        "orphan-1" as ToolRequestId,
        "get_files" as ToolName,
        { files: [{ filePath: "x.ts" }] },
      );
      stream.finishResponse("tool_use");
      // The executor is stalled, so no tool_result exists yet
      await toolsCalled;

      // Truncate at the assistant idx while the tool_use is unanswered
      agent.truncateMessages(1 as never);

      const messages = agent.log.messages;
      // Assistant message should still exist with text but no tool_use
      expect(messages).toHaveLength(2);
      expect(messages[1].role).toBe("assistant");
      const content = messages[1].content;
      expect(Array.isArray(content)).toBe(true);
      if (Array.isArray(content)) {
        expect(content.some((c) => c.type === "tool_use")).toBe(false);
      }

      releaseTools();
      expect(await turn).toEqual({ type: "aborted" });
    });

    it("drops the entire assistant message if it only contained an orphan tool_use", async () => {
      const mockClient = new MockAnthropicClient();
      let onCalled!: () => void;
      const toolsCalled = new Promise<void>((resolve) => {
        onCalled = resolve;
      });
      let releaseTools!: () => void;
      const agent = createAgent(mockClient, {
        executeTools: () => {
          onCalled();
          return new Promise((resolve) => {
            releaseTools = () =>
              resolve({ type: "aborted", results: new Map() });
          });
        },
      });

      const turn = agent.runTurn([
        {
          type: "text",
          text: "Run tool",
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
        },
      ]);
      const stream = await mockClient.awaitStream();
      stream.streamToolUse(
        "orphan-2" as ToolRequestId,
        "get_files" as ToolName,
        { files: [{ filePath: "x.ts" }] },
      );
      stream.finishResponse("tool_use");
      // The executor is stalled, so no tool_result exists yet
      await toolsCalled;

      // messages: [user, assistant w/only tool_use]
      agent.truncateMessages(1 as never);

      // Assistant message should be dropped entirely
      const messages = agent.log.messages;
      expect(messages).toHaveLength(1);
      expect(messages[0].role).toBe("user");

      releaseTools();
      expect(await turn).toEqual({ type: "aborted" });
    });

    it("clears messageStopInfo entries after the cut", async () => {
      const mockClient = new MockAnthropicClient();
      const agent = createAgent(mockClient);

      const turn = agent.runTurn([
        {
          type: "text",
          text: "Q1",
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
        },
      ]);
      let stream = await mockClient.awaitStream();
      stream.streamText("A1");
      stream.finishResponse("end_turn");
      await turn;

      const turn2 = agent.runTurn([
        {
          type: "text",
          text: "Q2",
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
        },
      ]);
      stream = await awaitNextStream(mockClient, 1);
      stream.streamText("A2");
      stream.finishResponse("end_turn");
      await turn2;

      // Cut at index 1
      agent.truncateMessages(1 as never);

      const messagesAfter = agent.log.messages;
      // Only the first assistant should still have stop info
      expect(messagesAfter[1].stopReason).toBe("end_turn");
    });
  });
});
