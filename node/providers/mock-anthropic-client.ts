import type Anthropic from "@anthropic-ai/sdk";
import { Defer, pollUntil } from "../utils/async.ts";
import type { ToolRequestId, ToolName, ToolRequest } from "@magenta/core";
import { validateInput } from "@magenta/core";
import type { ProviderMessage, StopReason, Usage } from "./provider-types.ts";
import type { Result } from "../utils/result.ts";
import { convertAnthropicMessagesToProvider } from "./anthropic-agent.ts";

type StreamEventCallback = (
  event: Anthropic.Messages.MessageStreamEvent,
) => void;

/** Minimal interface matching what AnthropicProviderThread uses from the Anthropic SDK */
export interface MockMessageStream {
  on(event: "streamEvent", callback: StreamEventCallback): this;
  finalMessage(): Promise<Anthropic.Message>;
  abort(): void;
}

/** A mock stream that tests can control to simulate Anthropic API responses */
export class MockStream implements MockMessageStream {
  private streamEventListeners: StreamEventCallback[] = [];
  private finalMessageDefer = new Defer<Anthropic.Message>();
  private contentBlocks: Anthropic.Messages.ContentBlock[] = [];
  private blockCounter = 0;
  public controller = new AbortController();

  constructor(public params: Anthropic.Messages.MessageStreamParams) {}

  /** Access messages that were sent in the request (raw Anthropic format) */
  get messages(): Anthropic.MessageParam[] {
    return this.params.messages;
  }

  /** Access messages converted to ProviderMessage format (for easier test assertions) */
  getProviderMessages(): ProviderMessage[] {
    return convertAnthropicMessagesToProvider(
      validateInput,
      this.params.messages,
    );
  }

  /** Access the system prompt that was sent in the request */
  get systemPrompt(): string | undefined {
    const system = this.params.system;
    if (!system) return undefined;
    if (typeof system === "string") return system;
    // Array of text blocks - concatenate them
    return system
      .map((block) => ("text" in block ? block.text : ""))
      .join("\n");
  }

  on(event: "streamEvent", callback: StreamEventCallback): this {
    if (event === "streamEvent") {
      this.streamEventListeners.push(callback);
    }
    return this;
  }

  finalMessage(): Promise<Anthropic.Message> {
    return this.finalMessageDefer.promise;
  }

  abort(): void {
    if (!this.finalMessageDefer.resolved) {
      this.controller.abort();
      this.finalMessageDefer.reject(new Error("Request aborted"));
    }
  }

  get aborted(): boolean {
    return this.controller.signal.aborted;
  }

  get resolved(): boolean {
    return this.finalMessageDefer.resolved;
  }

  private emit(event: Anthropic.Messages.MessageStreamEvent): void {
    for (const listener of this.streamEventListeners) {
      listener(event);
    }
  }

  // --- Test helper methods ---

  /** Stream a text block */
  streamText(text: string): void {
    const index = this.blockCounter++;

    this.emit({
      type: "content_block_start",
      index,
      content_block: { type: "text", text: "", citations: null },
    });

    this.emit({
      type: "content_block_delta",
      index,
      delta: { type: "text_delta", text },
    });

    this.emit({
      type: "content_block_stop",
      index,
    });

    this.contentBlocks.push({ type: "text", text, citations: null });
  }

  /** Stream a tool use block */
  streamToolUse(
    id: ToolRequestId,
    name: ToolName,
    input: Record<string, unknown>,
  ): void {
    const index = this.blockCounter++;

    this.emit({
      type: "content_block_start",
      index,
      content_block: { type: "tool_use", id, name, input: {} },
    });

    this.emit({
      type: "content_block_delta",
      index,
      delta: { type: "input_json_delta", partial_json: JSON.stringify(input) },
    });

    this.emit({
      type: "content_block_stop",
      index,
    });

    this.contentBlocks.push({ type: "tool_use", id, name, input });
  }

  /** Stream a thinking block */
  streamThinking(thinking: string, signature: string = ""): void {
    const index = this.blockCounter++;

    this.emit({
      type: "content_block_start",
      index,
      content_block: { type: "thinking", thinking: "", signature: "" },
    });

    this.emit({
      type: "content_block_delta",
      index,
      delta: { type: "thinking_delta", thinking },
    });

    if (signature) {
      this.emit({
        type: "content_block_delta",
        index,
        delta: {
          type: "signature_delta",
          signature,
        } as Anthropic.Messages.ContentBlockDeltaEvent["delta"],
      });
    }

    this.emit({
      type: "content_block_stop",
      index,
    });

    this.contentBlocks.push({ type: "thinking", thinking, signature });
  }

  /** Get the next block index for incremental streaming */
  nextBlockIndex(): number {
    return this.blockCounter++;
  }

  /** Emit a raw stream event for fine-grained control in tests */
  emitEvent(event: Anthropic.Messages.MessageStreamEvent): void {
    this.emit(event);
  }

  /** Stream a redacted thinking block */
  streamRedactedThinking(data: string): void {
    const index = this.blockCounter++;

    this.emit({
      type: "content_block_start",
      index,
      content_block: { type: "redacted_thinking", data },
    });

    this.emit({
      type: "content_block_stop",
      index,
    });

    this.contentBlocks.push({ type: "redacted_thinking", data });
  }

  /** Stream a server tool use (e.g., web_search) */
  streamServerToolUse(
    id: string,
    name: "web_search",
    input: { query: string },
  ): void {
    const index = this.blockCounter++;

    this.emit({
      type: "content_block_start",
      index,
      content_block: {
        type: "server_tool_use",
        id,
        name,
        input: {},
      } as unknown as Anthropic.Messages.ContentBlock,
    });

    this.emit({
      type: "content_block_delta",
      index,
      delta: { type: "input_json_delta", partial_json: JSON.stringify(input) },
    });

    this.emit({
      type: "content_block_stop",
      index,
    });

    this.contentBlocks.push({
      type: "server_tool_use",
      id,
      name,
      input,
    } as unknown as Anthropic.Messages.ContentBlock);
  }

  /** Stream a web search tool result */
  streamWebSearchToolResult(toolUseId: string, content: unknown): void {
    const index = this.blockCounter++;

    const block = {
      type: "web_search_tool_result",
      tool_use_id: toolUseId,
      content,
    } as unknown as Anthropic.Messages.ContentBlock;

    this.emit({
      type: "content_block_start",
      index,
      content_block: block,
    });

    this.emit({
      type: "content_block_stop",
      index,
    });

    this.contentBlocks.push(block);
  }

  /** Complete the response with the accumulated content blocks */
  finishResponse(
    stopReason: StopReason,
    usage: Usage = { inputTokens: 1000, outputTokens: 5000 },
  ): void {
    const message: Anthropic.Message = {
      id: `msg_mock_${Date.now()}`,
      type: "message",
      role: "assistant",
      content: this.contentBlocks,
      model: "mock-model",
      stop_reason: stopReason as Anthropic.Message["stop_reason"],
      stop_sequence: null,
      usage: {
        input_tokens: usage.inputTokens,
        inference_geo: null,
        output_tokens: usage.outputTokens,
        cache_read_input_tokens: usage.cacheHits ?? null,
        cache_creation_input_tokens: usage.cacheMisses ?? null,
        cache_creation: null,
        server_tool_use: null,
        service_tier: null,
      },
    };

    this.finalMessageDefer.resolve(message);
  }

  /** Reject the response with an error */
  respondWithError(error: Error): void {
    this.finalMessageDefer.reject(error);
  }

  /** High-level helper matching the legacy MockRequest interface */
  respond({
    text,
    toolRequests,
    stopReason,
    usage,
  }: {
    text: string;
    toolRequests: Result<ToolRequest, { rawRequest: unknown }>[];
    stopReason: StopReason;
    usage?: Usage;
  }): void {
    if (this.aborted) {
      return;
    }

    if (text) {
      this.streamText(text);
    }

    if (toolRequests && toolRequests.length > 0) {
      for (const toolRequest of toolRequests) {
        if (toolRequest.status === "ok") {
          this.streamToolUse(
            toolRequest.value.id,
            toolRequest.value.toolName,
            toolRequest.value.input as Record<string, unknown>,
          );
        } else {
          // For error cases, stream with the raw request
          const blockId = `block_error_${this.blockCounter++}`;
          this.streamToolUse(
            blockId as ToolRequestId,
            "unknown" as ToolName,
            (toolRequest as { rawRequest: unknown }).rawRequest as Record<
              string,
              unknown
            >,
          );
        }
      }
    }

    this.finishResponse(stopReason, usage);
  }
}

/** Validate that the Anthropic API constraint is satisfied:
 * every assistant message containing tool_use blocks must be immediately
 * followed by a user message with a tool_result for each tool_use.id.
 */
function validateToolUseConstraint(messages: Anthropic.MessageParam[]): void {
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== "assistant") continue;
    if (typeof msg.content === "string") continue;

    const toolUseIds = msg.content
      .filter(
        (block): block is Anthropic.ToolUseBlockParam =>
          block.type === "tool_use",
      )
      .map((block) => block.id);

    if (toolUseIds.length === 0) continue;

    const nextMsg = messages[i + 1];
    if (!nextMsg || nextMsg.role !== "user") {
      throw new Error(
        `MockAnthropicClient: assistant message at index ${i} contains tool_use blocks [${toolUseIds.join(", ")}] ` +
          `but is not followed by a user message with tool_results.`,
      );
    }

    if (typeof nextMsg.content === "string") {
      throw new Error(
        `MockAnthropicClient: user message at index ${i + 1} should contain tool_results for [${toolUseIds.join(", ")}] ` +
          `but has string content.`,
      );
    }

    const toolResultIds = new Set(
      (nextMsg.content as Anthropic.ToolResultBlockParam[])
        .filter(
          (block): block is Anthropic.ToolResultBlockParam =>
            block.type === "tool_result",
        )
        .map((block) => block.tool_use_id),
    );

    for (const id of toolUseIds) {
      if (!toolResultIds.has(id)) {
        throw new Error(
          `MockAnthropicClient: missing tool_result for tool_use id "${id}" in user message at index ${i + 1}.`,
        );
      }
    }
  }
}
/** Mock Anthropic client that creates MockStreams for testing */
export class MockAnthropicClient {
  public streams: MockStream[] = [];

  /** If set, countTokens will return this value as input_tokens */
  public mockInputTokenCount: number | undefined;

  messages = {
    stream: (params: Anthropic.Messages.MessageStreamParams): MockStream => {
      validateToolUseConstraint(params.messages);
      const stream = new MockStream(params);
      this.streams.push(stream);
      return stream;
    },
    countTokens: (
      _params: Anthropic.Messages.MessageCountTokensParams,
    ): Promise<{ input_tokens: number }> => {
      return Promise.resolve({ input_tokens: this.mockInputTokenCount ?? 0 });
    },
  };

  /** Get the most recent stream */
  get lastStream(): MockStream | undefined {
    return this.streams[this.streams.length - 1];
  }

  /** Wait for a pending (non-finished) stream */
  async awaitStream(): Promise<MockStream> {
    return pollUntil(() => {
      const stream = this.lastStream;
      if (stream && !stream.aborted) {
        return stream;
      }
      throw new Error("No pending stream");
    });
  }
}
