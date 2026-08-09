import type Anthropic from "@anthropic-ai/sdk";
import { MessageStream } from "@anthropic-ai/sdk/lib/MessageStream.mjs";
import type { ToolName, ToolRequestId } from "../tool-types.ts";
import { validateInput } from "../tools/helpers.ts";
import { pollUntil } from "../utils/async.ts";
import type { Result } from "../utils/result.ts";
import { convertAnthropicMessagesToProvider } from "./anthropic-conversion.ts";
import type {
  ProviderMessage,
  StreamStopReason,
  Usage,
} from "./provider-types.ts";

/** A mock stream that tests can control to simulate Anthropic API responses.
 *  Drives a real MessageStream via a ReadableStream so all event accumulation,
 *  partialParse, and finalMessage() assembly use the real SDK code path.
 */
export class MockStream {
  private readableController!: ReadableStreamDefaultController<Uint8Array>;
  private realStream: MessageStream;
  private blockCounter = 0;
  private messageStartEmitted = false;
  private _resolved = false;
  private _abortController = new AbortController();
  private _pushedEventCount = 0;
  private _processedEventCount = 0;
  private _partialToolIndex?: number;

  constructor(public params: Anthropic.Messages.MessageStreamParams) {
    const readable = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.readableController = controller;
      },
    });
    this.realStream = MessageStream.fromReadableStream(readable);

    this.realStream.on("streamEvent", () => {
      this._processedEventCount++;
    });
  }

  get messages(): Anthropic.MessageParam[] {
    return this.params.messages;
  }

  getProviderMessages(): ProviderMessage[] {
    return convertAnthropicMessagesToProvider(
      validateInput,
      this.params.messages,
    );
  }

  get systemPrompt(): string | undefined {
    const system = this.params.system;
    if (!system) return undefined;
    if (typeof system === "string") return system;
    return system
      .map((block) => ("text" in block ? block.text : ""))
      .join("\n");
  }

  on(
    event: "streamEvent",
    callback: (
      event: Anthropic.Messages.MessageStreamEvent,
      snapshot: Anthropic.Message,
    ) => void,
  ): this {
    if (event === "streamEvent") {
      this.realStream.on("streamEvent", callback);
    }
    return this;
  }

  finalMessage(): Promise<Anthropic.Message> {
    return this.realStream.finalMessage();
  }

  abort(): void {
    this._resolved = true;
    this._abortController.abort();
    try {
      this.readableController.close();
    } catch {
      // already closed
    }
    this.realStream.abort();
  }

  get controller(): AbortController {
    return this._abortController;
  }

  get aborted(): boolean {
    return this._abortController.signal.aborted;
  }

  get resolved(): boolean {
    return this._resolved;
  }

  private pushEvent(event: Anthropic.Messages.MessageStreamEvent): void {
    this._pushedEventCount++;
    const json = `${JSON.stringify(event)}\n`;
    const bytes = new TextEncoder().encode(json);
    this.readableController.enqueue(bytes);
  }

  private ensureMessageStart(): void {
    if (!this.messageStartEmitted) {
      this.messageStartEmitted = true;
      this.pushEvent({
        type: "message_start",
        message: {
          id: `msg_mock_${Date.now()}`,
          type: "message",
          role: "assistant",
          content: [],
          model: "mock-model",
          stop_reason: null,
          stop_sequence: null,
          container: null,
          stop_details: null,
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            cache_creation_input_tokens: null,
            cache_read_input_tokens: null,
            cache_creation: null,
            inference_geo: null,
            server_tool_use: null,
            service_tier: null,
            output_tokens_details: null,
          },
        },
      });
    }
  }

  /** Wait for all pushed events to be processed by the real MessageStream. */
  async settle(): Promise<void> {
    while (this._processedEventCount < this._pushedEventCount) {
      await new Promise<void>((resolve) => queueMicrotask(resolve));
    }
  }

  // --- Test helper methods ---

  streamText(text: string): void {
    this.ensureMessageStart();
    const index = this.blockCounter++;

    this.pushEvent({
      type: "content_block_start",
      index,
      content_block: { type: "text", text: "", citations: null },
    });
    this.pushEvent({
      type: "content_block_delta",
      index,
      delta: { type: "text_delta", text },
    });
    this.pushEvent({ type: "content_block_stop", index });
  }

  streamToolUse(
    id: ToolRequestId,
    name: ToolName,
    input: Record<string, unknown>,
  ): void {
    this.ensureMessageStart();
    const index = this.blockCounter++;

    this.pushEvent({
      type: "content_block_start",
      index,
      content_block: {
        type: "tool_use",
        id,
        name,
        input: {},
        caller: { type: "direct" as const },
      },
    });
    this.pushEvent({
      type: "content_block_delta",
      index,
      delta: { type: "input_json_delta", partial_json: JSON.stringify(input) },
    });
    this.pushEvent({ type: "content_block_stop", index });
  }

  /** Start a tool_use block and stream the given partial JSON chunks WITHOUT
   *  emitting content_block_stop, leaving the block as the live streaming block.
   *  Use to test streaming-input previews. Follow up with
   *  `continueToolUsePartial` to append more chunks to the same block. */
  streamToolUsePartial(
    id: ToolRequestId,
    name: ToolName,
    chunks: string[],
  ): void {
    this.ensureMessageStart();
    const index = this.blockCounter++;
    this._partialToolIndex = index;

    this.pushEvent({
      type: "content_block_start",
      index,
      content_block: {
        type: "tool_use",
        id,
        name,
        input: {},
        caller: { type: "direct" as const },
      },
    });
    for (const chunk of chunks) {
      this.pushEvent({
        type: "content_block_delta",
        index,
        delta: { type: "input_json_delta", partial_json: chunk },
      });
    }
  }

  /** Append more partial JSON chunks to the block started by
   *  `streamToolUsePartial`, without closing it. */
  continueToolUsePartial(chunks: string[]): void {
    const index = this._partialToolIndex;
    if (index === undefined) {
      throw new Error(
        "continueToolUsePartial called before streamToolUsePartial",
      );
    }
    for (const chunk of chunks) {
      this.pushEvent({
        type: "content_block_delta",
        index,
        delta: { type: "input_json_delta", partial_json: chunk },
      });
    }
  }

  streamThinking(thinking: string, signature: string = ""): void {
    this.ensureMessageStart();
    const index = this.blockCounter++;

    this.pushEvent({
      type: "content_block_start",
      index,
      content_block: { type: "thinking", thinking: "", signature: "" },
    });
    this.pushEvent({
      type: "content_block_delta",
      index,
      delta: { type: "thinking_delta", thinking },
    });
    if (signature) {
      this.pushEvent({
        type: "content_block_delta",
        index,
        delta: {
          type: "signature_delta",
          signature,
        } as Anthropic.Messages.ContentBlockDeltaEvent["delta"],
      });
    }
    this.pushEvent({ type: "content_block_stop", index });
  }

  streamRedactedThinking(data: string): void {
    this.ensureMessageStart();
    const index = this.blockCounter++;

    this.pushEvent({
      type: "content_block_start",
      index,
      content_block: { type: "redacted_thinking", data },
    });
    this.pushEvent({ type: "content_block_stop", index });
  }

  streamServerToolUse(
    id: string,
    name: "web_search",
    input: { query: string },
  ): void {
    this.ensureMessageStart();
    const index = this.blockCounter++;

    this.pushEvent({
      type: "content_block_start",
      index,
      content_block: {
        type: "server_tool_use",
        id,
        name,
        input: {},
      } as unknown as Anthropic.Messages.ContentBlock,
    });
    this.pushEvent({
      type: "content_block_delta",
      index,
      delta: { type: "input_json_delta", partial_json: JSON.stringify(input) },
    });
    this.pushEvent({ type: "content_block_stop", index });
  }

  streamWebSearchToolResult(toolUseId: string, content: unknown): void {
    this.ensureMessageStart();
    const index = this.blockCounter++;

    const block = {
      type: "web_search_tool_result",
      tool_use_id: toolUseId,
      content,
    } as unknown as Anthropic.Messages.ContentBlock;

    this.pushEvent({
      type: "content_block_start",
      index,
      content_block: block,
    });
    this.pushEvent({ type: "content_block_stop", index });
  }

  nextBlockIndex(): number {
    return this.blockCounter++;
  }

  emitEvent(event: Anthropic.Messages.MessageStreamEvent): void {
    if (
      event.type === "content_block_start" ||
      event.type === "content_block_delta" ||
      event.type === "content_block_stop" ||
      event.type === "message_delta"
    ) {
      this.ensureMessageStart();
    }
    this.pushEvent(event);
  }

  finishResponse(
    stopReason: StreamStopReason,
    usage: Usage = { inputTokens: 1000, outputTokens: 5000 },
  ): void {
    this._resolved = true;
    this.ensureMessageStart();
    this.pushEvent({
      type: "message_delta",
      delta: {
        stop_reason: stopReason as Anthropic.Message["stop_reason"],
        stop_sequence: null,
        container: null,
        stop_details: null,
      },
      usage: {
        output_tokens: usage.outputTokens,
        input_tokens: usage.inputTokens,
        cache_creation_input_tokens: usage.cacheMisses ?? null,
        cache_read_input_tokens: usage.cacheHits ?? null,
        server_tool_use: null,
        output_tokens_details: null,
      },
    });
    this.pushEvent({ type: "message_stop" });
    this.readableController.close();
  }

  respondWithError(error: Error): void {
    this._resolved = true;
    // Push an error event that will cause finalMessage() to reject
    // but NOT set the abort signal
    try {
      // Throw the error into the readable stream without aborting
      this.readableController.error(error);
    } catch {
      // If error fails, abort as fallback
      this.realStream.abort();
    }
  }

  respond({
    text,
    toolRequests,
    stopReason,
    usage,
  }: {
    text: string;
    toolRequests: Result<
      { id: ToolRequestId; toolName: ToolName; input: unknown },
      { rawRequest: unknown }
    >[];
    stopReason: StreamStopReason;
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
          const blockId = `block_error_${this.blockCounter}`;
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

  get lastStream(): MockStream | undefined {
    return this.streams[this.streams.length - 1];
  }

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
