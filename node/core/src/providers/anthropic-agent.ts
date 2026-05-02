import type Anthropic from "@anthropic-ai/sdk";
import { APIError } from "@anthropic-ai/sdk";
import type { MessageStream } from "@anthropic-ai/sdk/lib/MessageStream.mjs";
import { Emitter } from "../emitter.ts";
import type { Logger } from "../logger.ts";
import type { ToolName, ToolRequestId, ValidateInput } from "../tool-types.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import type {
  Agent,
  AgentEvents,
  AgentInput,
  AgentOptions,
  AgentState,
  AgentStatus,
  AgentStreamingBlock,
  NativeMessageIdx,
  ProviderMessage,
  ProviderToolResult,
} from "./provider-types.ts";
import { PLACEHOLDER_NATIVE_MESSAGE_IDX } from "./provider-types.ts";

export type AnthropicAgentOptions = {
  authType: "key" | "max" | "keychain";
  includeWebSearch: boolean;
  disableParallelToolUseFlag: boolean;
  logger: Logger;
  validateInput: ValidateInput;
};

// Internal streaming block type for all Anthropic block types
type AnthropicStreamingBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "tool_use"; id: ToolRequestId; name: ToolName; inputJson: string }
  | {
      type: "server_tool_use";
      id: string;
      name: "web_search";
      inputJson: string;
    }
  | {
      type: "web_search_tool_result";
      tool_use_id: string;
      content: Anthropic.WebSearchToolResultBlockContent;
    };

import type { StopReason, Usage } from "./provider-types.ts";

type MessageStopInfo = {
  stopReason: StopReason;
  usage: Usage;
};

/** Actions that trigger state transitions in the agent */
type Action =
  | { type: "start-streaming" }
  | {
      type: "block-started";
      index: number;
      block: Anthropic.Messages.ContentBlock;
    }
  | {
      type: "block-delta";
      index: number;
      delta: Anthropic.Messages.ContentBlockDeltaEvent["delta"];
    }
  | { type: "block-finished"; index: number }
  | { type: "stream-completed"; response: Anthropic.Message }
  | { type: "stream-error"; error: Error }
  | { type: "stream-aborted" };

export const RETRY_DELAYS = [1000, 5000, 10000, 30000];
export const MAX_RETRY_DURATION = 300_000;

export function isRetryableError(error: Error): boolean {
  return (
    error instanceof APIError && (error.status === 429 || error.status === 529)
  );
}

export function getRetryDelay(attempt: number): number {
  return attempt < RETRY_DELAYS.length
    ? RETRY_DELAYS[attempt]
    : RETRY_DELAYS[RETRY_DELAYS.length - 1];
}

export class AnthropicAgent extends Emitter<AgentEvents> implements Agent {
  private messages: Anthropic.MessageParam[] = [];
  private currentRequest: MessageStream | undefined;
  private params: Omit<Anthropic.Messages.MessageStreamParams, "messages">;
  private currentAnthropicBlock: AnthropicStreamingBlock | undefined;
  private status: AgentStatus = { type: "stopped", stopReason: "end_turn" };
  private latestUsage: Usage | undefined;
  /** Stop info for each assistant message, keyed by message index */
  private messageStopInfo: Map<number, MessageStopInfo> = new Map();
  /** Cached provider messages to avoid expensive conversion on every getState() */
  private cachedProviderMessages: ProviderMessage[] = [];
  /** Current block index during streaming, -1 when not streaming a block */
  private currentBlockIndex: number = -1;
  /** Assistant message being built during streaming */
  private currentAssistantMessage: Anthropic.MessageParam | undefined;
  /** Stored for cloning */
  private anthropicOptions: AnthropicAgentOptions;
  /** Promise that resolves when streaming stops, and its resolver */
  /** Token count for the full conversation, updated after each streaming completion */
  private inputTokenCount: number | undefined;
  private streamingEndPromise: Promise<void> | undefined;
  private streamingEndResolver: (() => void) | undefined;
  private retryAbortController: AbortController | undefined;

  constructor(
    private options: AgentOptions,
    private client: Anthropic,
    anthropicOptions: AnthropicAgentOptions,
  ) {
    super();
    this.anthropicOptions = anthropicOptions;
    this.params = this.createNativeStreamParameters(anthropicOptions);
  }

  private emitAsync<K extends keyof AgentEvents>(
    event: K,
    ...args: AgentEvents[K]
  ): void {
    queueMicrotask(() => {
      this.emit(event, ...args);
    });
  }

  private update(action: Action): void {
    switch (action.type) {
      case "start-streaming":
        this.status = { type: "streaming", startTime: new Date() };
        this.currentBlockIndex = -1;
        this.currentAssistantMessage = undefined;
        this.streamingEndPromise = new Promise((resolve) => {
          this.streamingEndResolver = resolve;
        });

        break;

      case "block-started":
        if (this.currentBlockIndex !== -1) {
          throw new Error(
            `Received content_block_start at index ${action.index} while block ${this.currentBlockIndex} is still open`,
          );
        }
        this.currentBlockIndex = action.index;
        this.currentAnthropicBlock = this.initAnthropicStreamingBlock(
          action.block,
        );

        break;

      case "block-delta":
        if (action.index !== this.currentBlockIndex) {
          throw new Error(
            `Received content_block_delta for index ${action.index} but current block is ${this.currentBlockIndex}`,
          );
        }
        if (this.currentAnthropicBlock) {
          this.currentAnthropicBlock = this.applyAnthropicDelta(
            this.currentAnthropicBlock,
            action.delta,
          );
        }
        break;

      case "block-finished": {
        if (action.index !== this.currentBlockIndex) {
          throw new Error(
            `Received content_block_stop for index ${action.index} but current block is ${this.currentBlockIndex}`,
          );
        }

        if (!this.currentAssistantMessage) {
          this.currentAssistantMessage = {
            role: "assistant",
            content: [],
          };
          this.messages.push(this.currentAssistantMessage);
        }

        const content = this.currentAssistantMessage
          .content as Anthropic.Messages.ContentBlockParam[];
        if (this.currentAnthropicBlock) {
          content.push(
            this.anthropicStreamingBlockToParam(this.currentAnthropicBlock),
          );
        }
        this.currentAnthropicBlock = undefined;
        this.updateCachedProviderMessages();
        this.currentBlockIndex = -1;
        break;
      }

      case "stream-completed": {
        this.currentRequest = undefined;
        const response = action.response;

        if (!this.currentAssistantMessage) {
          this.currentAssistantMessage = {
            role: "assistant",
            content: [],
          };
          this.messages.push(this.currentAssistantMessage);
        }

        (
          this.currentAssistantMessage
            .content as Anthropic.Messages.ContentBlockParam[]
        ).length = 0;
        for (const block of response.content) {
          (
            this.currentAssistantMessage
              .content as Anthropic.Messages.ContentBlockParam[]
          ).push(this.responseBlockToParam(block));
        }

        this.updateCachedProviderMessages();

        const usage: Usage = {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
        };
        if (response.usage.cache_read_input_tokens != null) {
          usage.cacheHits = response.usage.cache_read_input_tokens;
        }
        if (response.usage.cache_creation_input_tokens != null) {
          usage.cacheMisses = response.usage.cache_creation_input_tokens;
        }

        this.latestUsage = usage;
        this.anthropicOptions.logger.info(
          `Usage: inputTokens=${usage.inputTokens} outputTokens=${usage.outputTokens} cacheHits=${usage.cacheHits ?? 0} cacheMisses=${usage.cacheMisses ?? 0} stopReason=${response.stop_reason}`,
        );
        const stopReason = response.stop_reason || "end_turn";
        const messageIndex = this.messages.indexOf(
          this.currentAssistantMessage,
        );
        this.messageStopInfo.set(messageIndex, { stopReason, usage });

        this.currentAssistantMessage = undefined;
        this.status = { type: "stopped", stopReason };
        this.resolveStreamingEnd();
        this.countTokensPostFlight();
        this.emitAsync("stopped", stopReason, usage);
        break;
      }

      case "stream-error": {
        this.currentRequest = undefined;
        this.cleanup({ type: "error", error: action.error });
        this.currentAssistantMessage = undefined;
        this.status = { type: "error", error: action.error };
        this.resolveStreamingEnd();
        this.countTokensPostFlight();
        this.emitAsync("error", action.error);
        break;
      }

      case "stream-aborted":
        this.currentRequest = undefined;
        this.cleanup({ type: "aborted" });
        this.currentAssistantMessage = undefined;
        this.status = { type: "stopped", stopReason: "aborted" };
        this.resolveStreamingEnd();
        this.countTokensPostFlight();
        this.emitAsync("stopped", "aborted", undefined);
        break;

      default:
        assertUnreachable(action);
    }

    this.emitAsync("didUpdate");
  }

  getState(): AgentState {
    return {
      status: this.status,
      messages: this.cachedProviderMessages,
      streamingBlock: this.getStreamingBlock(),
      latestUsage: this.latestUsage,
      inputTokenCount: this.inputTokenCount,
    };
  }

  getStreamingBlock(): AgentStreamingBlock | undefined {
    if (!this.currentAnthropicBlock) {
      return undefined;
    }
    // Only expose types that AgentStreamingBlock supports
    switch (this.currentAnthropicBlock.type) {
      case "text":
      case "thinking":
      case "tool_use":
        return this.currentAnthropicBlock;
      default:
        return undefined;
    }
  }

  /** Get a copy of the native Anthropic messages for use in context piping */
  getNativeMessages(): Anthropic.MessageParam[] {
    return [...this.messages];
  }

  getNativeMessageIdx(): NativeMessageIdx {
    return (this.messages.length - 1) as NativeMessageIdx;
  }

  appendUserMessage(content: AgentInput[]): void {
    const nativeContent = this.convertInputToNative(content);
    this.messages.push({
      role: "user",
      content: nativeContent,
    });
    this.updateCachedProviderMessages();
  }

  toolResult(toolUseId: ToolRequestId, result: ProviderToolResult): void {
    if (
      this.status.type !== "stopped" ||
      (this.status.stopReason !== "tool_use" &&
        this.status.stopReason !== "max_tokens")
    ) {
      throw new Error(
        `Cannot provide tool result: expected status stopped with stopReason tool_use, but got ${JSON.stringify(this.status)}`,
      );
    }

    const lastMessage = this.messages[this.messages.length - 1];
    if (!lastMessage || lastMessage.role !== "assistant") {
      throw new Error(
        `Cannot provide tool result: expected last message to be from assistant, but got ${lastMessage?.role ?? "no message"}`,
      );
    }

    const assistantContent = lastMessage.content;
    if (typeof assistantContent === "string") {
      throw new Error(
        `Cannot provide tool result: assistant message has string content instead of blocks`,
      );
    }

    const hasMatchingToolUse = assistantContent.some(
      (block) => block.type === "tool_use" && block.id === toolUseId,
    );
    if (!hasMatchingToolUse) {
      throw new Error(
        `Cannot provide tool result: no tool_use block with id ${toolUseId} found in assistant message`,
      );
    }

    const nativeContent = this.convertToolResultToNative(toolUseId, result);

    // Tool results go in a user message
    this.messages.push({
      role: "user",
      content: nativeContent,
    });
    this.updateCachedProviderMessages();
  }

  abort(): Promise<void> {
    // Cancel any pending retry wait
    if (this.retryAbortController) {
      this.retryAbortController.abort();
    }
    if (this.currentRequest) {
      this.currentRequest.abort();
      return this.streamingEndPromise || Promise.resolve();
    }
    return this.streamingEndPromise || Promise.resolve();
  }

  abortToolUse(): void {
    if (
      this.status.type !== "stopped" ||
      this.status.stopReason !== "tool_use"
    ) {
      throw new Error(
        `Cannot abortToolUse: expected status stopped with stopReason tool_use, but got ${JSON.stringify(this.status)}`,
      );
    }
    this.status = { type: "stopped", stopReason: "aborted" };
    this.emitAsync("stopped", "aborted", undefined);
  }

  private resolveStreamingEnd(): void {
    if (this.streamingEndResolver) {
      this.streamingEndResolver();
      this.streamingEndResolver = undefined;
      this.streamingEndPromise = undefined;
    }
  }

  continueConversation(): void {
    this.update({ type: "start-streaming" });
    const startTime = (this.status as { startTime: Date }).startTime;

    const attemptStream = (): Promise<
      | { type: "completed"; response: Anthropic.Message }
      | { type: "aborted" }
      | { type: "error"; error: Error }
    > => {
      const messagesWithCache = withCacheControl(this.messages);
      this.currentRequest = this.client.messages.stream({
        ...this.params,
        messages: messagesWithCache,
      });

      this.currentRequest.on("streamEvent", (event) => {
        switch (event.type) {
          case "content_block_start":
            this.update({
              type: "block-started",
              index: event.index,
              block: event.content_block,
            });
            break;

          case "content_block_delta":
            this.update({
              type: "block-delta",
              index: event.index,
              delta: event.delta,
            });
            break;

          case "content_block_stop":
            this.update({ type: "block-finished", index: event.index });
            break;
        }
      });

      return this.currentRequest
        .finalMessage()
        .then((response) => ({ type: "completed" as const, response }))
        .catch((error: Error) => {
          const aborted = this.currentRequest?.controller.signal.aborted;
          if (aborted) {
            return { type: "aborted" as const };
          }
          return { type: "error" as const, error };
        });
    };

    const runWithRetry = async () => {
      let attempt = 0;
      while (true) {
        // Clear retryStatus when starting a new attempt
        this.status = { type: "streaming", startTime };
        if (attempt > 0) {
          this.emit("didUpdate");
        }

        const result = await attemptStream();

        if (result.type === "completed") {
          this.update({ type: "stream-completed", response: result.response });
          return;
        }
        if (result.type === "aborted") {
          this.update({ type: "stream-aborted" });
          return;
        }

        // result.type === "error"
        const elapsed = Date.now() - startTime.getTime();
        if (!isRetryableError(result.error) || elapsed >= MAX_RETRY_DURATION) {
          this.update({ type: "stream-error", error: result.error });
          return;
        }

        const delay = getRetryDelay(attempt);
        const nextRetryAt = new Date(Date.now() + delay);
        this.status = {
          type: "streaming",
          startTime,
          retryStatus: {
            attempt: attempt + 1,
            nextRetryAt,
            error: result.error,
          },
        };
        this.emit("didUpdate");

        // Wait for the delay, but allow abort to cancel
        this.retryAbortController = new AbortController();
        const abortSignal = this.retryAbortController.signal;
        try {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, delay);
            abortSignal.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                reject(new DOMException("Aborted", "AbortError"));
              },
              { once: true },
            );
          });
        } catch {
          // Abort during retry wait
          this.retryAbortController = undefined;
          this.update({ type: "stream-aborted" });
          return;
        }
        this.retryAbortController = undefined;
        attempt++;
      }
    };

    runWithRetry();
  }

  private countTokensPostFlight(): void {
    if (this.options.skipPostFlightTokenCount) return;
    if (typeof this.client.messages.countTokens !== "function") {
      return;
    }
    const messagesWithCache = withCacheControl(this.messages);
    const countParams: Anthropic.Messages.MessageCountTokensParams = {
      model: this.params.model,
      messages: messagesWithCache,
    };
    if (this.params.system) countParams.system = this.params.system;
    if (this.params.tools) countParams.tools = this.params.tools;
    if (this.params.tool_choice)
      countParams.tool_choice = this.params.tool_choice;
    if (this.params.thinking) countParams.thinking = this.params.thinking;
    this.client.messages
      .countTokens(countParams)
      .then((result) => {
        this.inputTokenCount = result.input_tokens;
        this.emitAsync("didUpdate");
      })
      .catch((error: unknown) => {
        this.anthropicOptions.logger.warn(
          `countTokens post-flight failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  }

  truncateMessages(messageIdx: NativeMessageIdx): void {
    const endIdx = this.computeTruncateEndIdx(messageIdx);

    // Slice once, handles endIdx === -1 by setting length 0
    this.messages.length = endIdx + 1;

    // Clean up messageStopInfo for removed messages
    for (const idx of this.messageStopInfo.keys()) {
      if (idx > endIdx) {
        this.messageStopInfo.delete(idx);
      }
    }

    this.status = { type: "stopped", stopReason: "end_turn" };
    this.updateCachedProviderMessages();
    this.emitAsync("stopped", "end_turn", undefined);
  }

  /** Decide where to cut the messages array for a truncate at `messageIdx`.
   * If messages[messageIdx] is an assistant message containing tool_use blocks
   * whose tool_results all appear in the consecutive following user messages,
   * extend forward to keep those tool_result messages too.
   * Otherwise drop orphan tool_use / server_tool_use blocks (and the message
   * itself if it would become empty). Returns the inclusive end index, or -1
   * to drop everything. May mutate messages[messageIdx].content in place.
   */
  private computeTruncateEndIdx(messageIdx: NativeMessageIdx): number {
    if (messageIdx < 0 || messageIdx >= this.messages.length) {
      return Math.min(messageIdx, this.messages.length - 1);
    }

    const target = this.messages[messageIdx];
    if (target.role === "user") {
      return messageIdx;
    }

    const content = target.content;
    if (typeof content === "string") {
      return messageIdx;
    }

    const toolUseIds = new Set<string>();
    for (const block of content) {
      if (block.type === "tool_use") {
        toolUseIds.add(block.id);
      }
    }

    if (toolUseIds.size > 0) {
      // Walk forward through the run of consecutive user messages collecting
      // matching tool_result IDs.
      const foundResultIds = new Set<string>();
      let lastResultIdx: number = messageIdx;
      let m = messageIdx + 1;
      while (m < this.messages.length && this.messages[m].role === "user") {
        const userContent = this.messages[m].content;
        if (Array.isArray(userContent)) {
          for (const block of userContent) {
            if (block.type === "tool_result") {
              foundResultIds.add(block.tool_use_id);
            }
          }
        }
        lastResultIdx = m;
        m += 1;
      }

      let allFound = true;
      for (const id of toolUseIds) {
        if (!foundResultIds.has(id)) {
          allFound = false;
          break;
        }
      }

      if (allFound) {
        return lastResultIdx;
      }
    }

    // Drop orphan tool_use / server_tool_use blocks.
    const trimmed = content.filter((block, idx) => {
      if (block.type === "tool_use") return false;
      if ((block as { type: string }).type === "server_tool_use") {
        const next = content[idx + 1];
        if (
          next &&
          (next as { type: string }).type === "web_search_tool_result"
        ) {
          return true;
        }
        return false;
      }
      return true;
    });

    if (trimmed.length === 0) {
      return messageIdx - 1;
    }

    target.content = trimmed;
    return messageIdx;
  }

  clone(): AnthropicAgent {
    const cloned = new AnthropicAgent(
      this.options,
      this.client,
      this.anthropicOptions,
    );

    // Deep copy messages — during streaming, this.messages already contains
    // a reference to currentAssistantMessage with all finalized blocks
    // (but not the in-progress currentAnthropicBlock)
    cloned.messages = JSON.parse(JSON.stringify(this.messages));

    // Clean up the cloned messages to handle incomplete state
    AnthropicAgent.cleanupClonedMessages(cloned.messages);

    // Deep copy messageStopInfo
    cloned.messageStopInfo = new Map(
      Array.from(this.messageStopInfo.entries()).map(([k, v]) => [
        k,
        { ...v, usage: { ...v.usage } },
      ]),
    );

    // Cloned agent is always in stopped/end_turn state
    cloned.status = { type: "stopped", stopReason: "end_turn" };

    // Copy latestUsage and inputTokenCount if present
    if (this.latestUsage) {
      cloned.latestUsage = { ...this.latestUsage };
    }
    cloned.inputTokenCount = this.inputTokenCount;

    // Rebuild cached provider messages from the cloned data
    cloned.cachedProviderMessages = convertAnthropicMessagesToProvider(
      this.anthropicOptions.validateInput,
      cloned.messages,
      cloned.messageStopInfo,
    );

    return cloned;
  }

  /** Clean up a deep-copied messages array for use in a cloned agent.
   * Handles: dropping server_tool_use blocks, adding error tool_results
   * for tool_use blocks, filtering empty blocks, and removing empty messages.
   */
  private static cleanupClonedMessages(
    messages: Anthropic.MessageParam[],
  ): void {
    if (messages.length === 0) return;

    const lastMessage = messages[messages.length - 1];
    if (!lastMessage || lastMessage.role !== "assistant") return;

    const lastMessageContent = lastMessage.content;
    if (typeof lastMessageContent === "string") return;

    // Collect tool_use IDs that need error tool_results
    const toolUseIds: { id: string }[] = [];

    // Filter out server_tool_use blocks and empty/incomplete blocks
    lastMessage.content = lastMessageContent.filter((block) => {
      if ((block as { type: string }).type === "server_tool_use") return false;
      if (block.type === "text" && !block.text) return false;
      if (block.type === "thinking" && !block.thinking) return false;
      if (block.type === "tool_use") {
        toolUseIds.push({ id: block.id });
      }
      return true;
    });

    // If the assistant message is now empty, remove it
    if (lastMessage.content.length === 0) {
      messages.pop();
    } else if (toolUseIds.length > 0) {
      // Add error tool_results for each tool_use block
      messages.push({
        role: "user",
        content: toolUseIds.map((t) => ({
          type: "tool_result" as const,
          tool_use_id: t.id,
          content: "The thread was forked before the tool could execute.",
          is_error: true,
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
        })),
      });
    }
  }

  private cleanup(
    reason: { type: "aborted" } | { type: "error"; error: Error },
  ): void {
    this.currentAnthropicBlock = undefined;

    const lastMessage = this.messages[this.messages.length - 1];
    if (!lastMessage || lastMessage.role !== "assistant") {
      return;
    }

    const lastMessageContent = lastMessage.content;
    if (
      typeof lastMessageContent !== "string" &&
      lastMessageContent.length > 0
    ) {
      const lastBlock = lastMessageContent[lastMessageContent.length - 1];

      if ((lastBlock as { type: string }).type === "server_tool_use") {
        lastMessageContent.pop();
      } else if (lastBlock.type === "tool_use") {
        const errorMessage =
          reason.type === "aborted"
            ? "Request was aborted by the user before tool execution completed."
            : `Stream error occurred: ${reason.error.message}`;

        this.messages.push({
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: lastBlock.id,
              content: errorMessage,
              is_error: true,
            },
          ],
        });
        this.updateCachedProviderMessages();
        return;
      }

      // Filter out empty/incomplete blocks that can result from aborting mid-stream.
      // Anthropic rejects empty text blocks with 400 "text content blocks must be non-empty".
      lastMessage.content = lastMessageContent.filter((block) => {
        if (block.type === "text" && !block.text) return false;
        if (block.type === "thinking" && !block.thinking) return false;
        return true;
      });
    }

    if (
      (typeof lastMessage.content === "string" && !lastMessage.content) ||
      (typeof lastMessage.content !== "string" &&
        lastMessage.content.length === 0)
    ) {
      this.messages.pop();
    }

    this.updateCachedProviderMessages();
  }

  private createNativeStreamParameters(
    anthropicOptions: AnthropicAgentOptions,
  ): Omit<Anthropic.Messages.MessageStreamParams, "messages"> {
    const { authType, includeWebSearch, disableParallelToolUseFlag } =
      anthropicOptions;
    const { model, tools, systemPrompt, thinking } = this.options;

    const anthropicTools: Anthropic.Tool[] = tools.map((t): Anthropic.Tool => {
      return {
        ...t,
        input_schema: t.input_schema as Anthropic.Messages.Tool.InputSchema,
      };
    });

    const systemBlocks: Anthropic.Messages.MessageStreamParams["system"] = [
      {
        type: "text" as const,
        text: systemPrompt,
        cache_control: { type: "ephemeral" },
      },
    ];

    if (authType === "max" || authType === "keychain") {
      systemBlocks.unshift({
        type: "text" as const,
        text: CLAUDE_CODE_SPOOF_PROMPT,
      });
    }

    const builtInTools: Anthropic.Messages.Tool[] = [];
    if (includeWebSearch) {
      builtInTools.push({
        type: "web_search_20250305",
        name: "web_search",
        max_uses: 5,
      } as unknown as Anthropic.Messages.Tool);
    }

    const toolChoice: Anthropic.Messages.ToolChoice = disableParallelToolUseFlag
      ? { type: "auto", disable_parallel_tool_use: true }
      : { type: "auto" };

    const params: Omit<Anthropic.Messages.MessageStreamParams, "messages"> = {
      model: model,
      max_tokens: getMaxTokensForModel(model),
      system: systemBlocks,
      tool_choice: toolChoice,
      tools: [...anthropicTools, ...builtInTools],
    };

    if (thinking?.enabled) {
      if (supportsAdaptiveThinking(model)) {
        params.thinking = {
          type: "adaptive",
          display: thinking.displayThinking ? "summarized" : "omitted",
        };
      } else {
        params.thinking = {
          type: "enabled",
          budget_tokens: thinking.budgetTokens || 1024,
        };
      }
    }

    const outputConfig = resolveOutputConfig(
      model,
      thinking,
      this.anthropicOptions.logger,
    );
    if (outputConfig) {
      params.output_config = outputConfig;
    }

    return params;
  }

  private initAnthropicStreamingBlock(
    contentBlock: Anthropic.Messages.ContentBlock,
  ): AnthropicStreamingBlock | undefined {
    switch (contentBlock.type) {
      case "text":
        return { type: "text", text: contentBlock.text };
      case "thinking":
        return {
          type: "thinking",
          thinking: contentBlock.thinking,
          signature: "",
        };
      case "tool_use":
        return {
          type: "tool_use",
          id: contentBlock.id as ToolRequestId,
          name: contentBlock.name as ToolName,
          inputJson: "",
        };
      default:
        // Handle server_tool_use and web_search_tool_result
        if ((contentBlock as { type: string }).type === "server_tool_use") {
          return {
            type: "server_tool_use",
            id: (contentBlock as { id: string }).id,
            name: "web_search",
            inputJson: "",
          };
        }
        if (
          (contentBlock as { type: string }).type === "web_search_tool_result"
        ) {
          const block = contentBlock as {
            type: "web_search_tool_result";
            tool_use_id: string;
            content: Anthropic.WebSearchToolResultBlockContent;
          };
          return {
            type: "web_search_tool_result",
            tool_use_id: block.tool_use_id,
            content: block.content,
          };
        }
        return undefined;
    }
  }

  private applyAnthropicDelta(
    block: AnthropicStreamingBlock,
    delta: Anthropic.Messages.ContentBlockDeltaEvent["delta"],
  ): AnthropicStreamingBlock {
    switch (delta.type) {
      case "text_delta":
        if (block.type === "text") {
          return { ...block, text: block.text + delta.text };
        }
        break;
      case "thinking_delta":
        if (block.type === "thinking") {
          return { ...block, thinking: block.thinking + delta.thinking };
        }
        break;
      case "signature_delta":
        if (block.type === "thinking") {
          return { ...block, signature: block.signature + delta.signature };
        }
        break;
      case "input_json_delta":
        if (block.type === "tool_use" || block.type === "server_tool_use") {
          return {
            ...block,
            inputJson: block.inputJson + delta.partial_json,
          };
        }
        break;
    }
    return block;
  }

  private anthropicStreamingBlockToParam(
    block: AnthropicStreamingBlock,
  ): Anthropic.Messages.ContentBlockParam {
    switch (block.type) {
      case "text":
        return { type: "text", text: block.text, citations: null };
      case "thinking":
        return {
          type: "thinking",
          thinking: block.thinking,
          signature: block.signature,
        };
      case "tool_use": {
        let input: Record<string, unknown> = {};
        try {
          if (block.inputJson) {
            input = JSON.parse(block.inputJson) as Record<string, unknown>;
          }
        } catch {
          // If JSON is incomplete/invalid, store what we have
        }
        return {
          type: "tool_use",
          id: block.id,
          name: block.name,
          input,
        };
      }
      case "server_tool_use": {
        let input: Record<string, unknown> = {};
        try {
          if (block.inputJson) {
            input = JSON.parse(block.inputJson) as Record<string, unknown>;
          }
        } catch {
          // If JSON is incomplete/invalid, store what we have
        }
        return {
          type: "server_tool_use",
          id: block.id,
          name: block.name,
          input,
        } as unknown as Anthropic.Messages.ContentBlockParam;
      }
      case "web_search_tool_result":
        return {
          type: "web_search_tool_result",
          tool_use_id: block.tool_use_id,
          content: block.content,
        } as unknown as Anthropic.Messages.ContentBlockParam;
    }
  }

  private responseBlockToParam(
    block: Anthropic.Messages.ContentBlock,
  ): Anthropic.Messages.ContentBlockParam {
    switch (block.type) {
      case "text":
        return {
          type: "text",
          text: block.text,
          citations: block.citations?.length ? block.citations : null,
        };
      case "thinking":
        return {
          type: "thinking",
          thinking: block.thinking,
          signature: block.signature,
        };
      case "redacted_thinking":
        return {
          type: "redacted_thinking",
          data: block.data,
        };
      case "tool_use":
        return {
          type: "tool_use",
          id: block.id,
          name: block.name,
          input: block.input as Record<string, unknown>,
        };
      default:
        // For server_tool_use, web_search_tool_result, etc.
        return block as Anthropic.Messages.ContentBlockParam;
    }
  }

  private convertInputToNative(
    content: AgentInput[],
  ): Anthropic.MessageParam["content"] {
    // biome-ignore lint/suspicious/useIterableCallbackReturn: exhaustive switch handles all cases
    return content.map((c): Anthropic.Messages.ContentBlockParam => {
      switch (c.type) {
        case "text":
          return { type: "text", text: c.text };
        case "image":
          return { type: "image", source: c.source };
        case "document":
          return {
            type: "document",
            source: c.source,
            title: c.title || null,
          };
        default:
          assertUnreachable(c);
      }
    });
  }

  private convertToolResultToNative(
    toolUseId: ToolRequestId,
    result: ProviderToolResult,
  ): Anthropic.Messages.ContentBlockParam[] {
    if (result.result.status === "ok") {
      const contents: Array<
        Anthropic.Messages.TextBlockParam | Anthropic.Messages.ImageBlockParam
      > = [];

      for (const content of result.result.value) {
        switch (content.type) {
          case "text":
            contents.push({ type: "text", text: content.text });
            break;
          case "image":
            contents.push({ type: "image", source: content.source });
            break;
          case "document":
            // Documents need special handling - return as separate blocks
            // For now, skip and handle documents separately below
            break;
          default:
            assertUnreachable(content);
        }
      }

      const blocks: Anthropic.Messages.ContentBlockParam[] = [
        {
          type: "tool_result",
          tool_use_id: toolUseId,
          content: contents,
          is_error: false,
        },
      ];

      // Add document blocks separately
      for (const content of result.result.value) {
        if (content.type === "document") {
          blocks.push({
            type: "document",
            source: content.source,
            title: content.title || null,
          });
        }
      }

      return blocks;
    } else {
      return [
        {
          type: "tool_result",
          tool_use_id: toolUseId,
          content: result.result.error,
          is_error: true,
        },
      ];
    }
  }

  private updateCachedProviderMessages(): void {
    this.cachedProviderMessages = convertAnthropicMessagesToProvider(
      this.anthropicOptions.validateInput,
      this.messages,
      this.messageStopInfo,
    );
    this.emitAsync("didUpdate");
  }
}

/** Convert Anthropic messages to ProviderMessages. Exported for use in tests. */
export function convertAnthropicMessagesToProvider(
  validateInput: ValidateInput,
  messages: Anthropic.MessageParam[],
  messageStopInfo?: Map<number, MessageStopInfo>,
): ProviderMessage[] {
  return messages.map((msg, msgIndex): ProviderMessage => {
    const stopInfo = messageStopInfo?.get(msgIndex);
    const nativeMessageIdx = msgIndex as NativeMessageIdx;
    const content =
      typeof msg.content === "string"
        ? [
            {
              type: "text" as const,
              text: msg.content,
              nativeMessageIdx,
            },
          ]
        : msg.content.map((block) =>
            convertBlockToProvider(validateInput, block, nativeMessageIdx),
          );

    const result: ProviderMessage = {
      role: msg.role,
      content,
    };

    // Attach stop info to assistant messages
    if (stopInfo && msg.role === "assistant") {
      result.stopReason = stopInfo.stopReason;
      result.usage = stopInfo.usage;
    }

    return result;
  });
}

function convertBlockToProvider(
  validateInput: ValidateInput,
  block: Anthropic.Messages.ContentBlockParam,
  nativeMessageIdx: NativeMessageIdx,
): ProviderMessage["content"][number] {
  switch (block.type) {
    case "text": {
      // Detect system_reminder blocks (converted to text with <system-reminder> tags)
      if (block.text.includes("<system-reminder>")) {
        return {
          type: "system_reminder",
          text: block.text,
          nativeMessageIdx,
        };
      }
      // Detect context_update blocks (converted to text with <context_update> tags)
      if (block.text.includes("<context_update>")) {
        return {
          type: "context_update",
          text: block.text,
          nativeMessageIdx,
        };
      }
      return {
        type: "text",
        text: block.text,
        nativeMessageIdx,
        citations: block.citations
          ? block.citations
              .filter(
                (
                  c,
                ): c is Extract<
                  (typeof block.citations)[number],
                  { url: string }
                > => "url" in c,
              )
              .map((c) => ({
                type: "web_search_citation" as const,
                cited_text: c.cited_text,
                encrypted_index: c.encrypted_index,
                title: c.title || "",
                url: c.url,
              }))
          : undefined,
      };
    }

    case "image":
      return {
        type: "image",
        source: block.source as {
          type: "base64";
          media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
          data: string;
        },
        nativeMessageIdx,
      };

    case "document":
      return {
        type: "document",
        source: block.source as {
          type: "base64";
          media_type: "application/pdf";
          data: string;
        },
        title: block.title ?? null,
        nativeMessageIdx,
      };

    case "tool_use": {
      const inputResult = validateInput(
        block.name as ToolName,
        block.input as Record<string, unknown>,
      );
      return {
        type: "tool_use",
        id: block.id as ToolRequestId,
        name: block.name as ToolName,
        request:
          inputResult.status === "ok"
            ? {
                status: "ok" as const,
                value: {
                  id: block.id as ToolRequestId,
                  toolName: block.name as ToolName,
                  input: inputResult.value,
                },
              }
            : { ...inputResult, rawRequest: block.input },
        nativeMessageIdx,
      };
    }

    case "tool_result": {
      let contents: ProviderToolResult["result"];

      if (typeof block.content === "string") {
        contents = block.is_error
          ? { status: "error", error: block.content }
          : {
              status: "ok",
              value: [
                {
                  type: "text",
                  text: block.content,
                  nativeMessageIdx,
                },
              ],
              structuredResult: {
                toolName: "unknown" as ToolName,
              },
            };
      } else if (block.is_error) {
        const textBlock = block.content?.find((c) => c.type === "text") as
          | { type: "text"; text: string }
          | undefined;
        contents = {
          status: "error",
          error: textBlock?.text || "Unknown error",
        };
      } else {
        const blockContent = block.content || [];
        contents = {
          status: "ok",
          value: blockContent
            .filter(
              (
                c,
              ): c is
                | Anthropic.Messages.TextBlockParam
                | Anthropic.Messages.ImageBlockParam =>
                c.type === "text" || c.type === "image",
            )
            .map((c) => {
              if (c.type === "text") {
                return {
                  type: "text" as const,
                  text: c.text,
                  nativeMessageIdx,
                };
              } else {
                return {
                  type: "image" as const,
                  source: c.source as {
                    type: "base64";
                    media_type:
                      | "image/jpeg"
                      | "image/png"
                      | "image/gif"
                      | "image/webp";
                    data: string;
                  },
                  nativeMessageIdx,
                };
              }
            }),
          structuredResult: {
            toolName: "unknown" as ToolName,
          },
        };
      }

      return {
        type: "tool_result",
        id: block.tool_use_id as ToolRequestId,
        result: contents,
        nativeMessageIdx,
      };
    }

    case "thinking":
      return {
        type: "thinking",
        thinking: block.thinking,
        signature: block.signature,
        nativeMessageIdx,
      };

    case "redacted_thinking":
      return {
        type: "redacted_thinking",
        data: block.data,
        nativeMessageIdx,
      };

    default:
      // Handle server_tool_use, web_search_tool_result etc.
      if ((block as { type: string }).type === "server_tool_use") {
        const serverBlock = block as {
          type: "server_tool_use";
          id: string;
          name: string;
          input: { query: string };
        };
        return {
          type: "server_tool_use",
          id: serverBlock.id,
          name: "web_search",
          input: serverBlock.input,
          nativeMessageIdx,
        };
      }
      if ((block as { type: string }).type === "web_search_tool_result") {
        const resultBlock = block as {
          type: "web_search_tool_result";
          tool_use_id: string;
          content: Anthropic.WebSearchToolResultBlockContent;
        };
        return {
          type: "web_search_tool_result",
          tool_use_id: resultBlock.tool_use_id,
          content: resultBlock.content,
          nativeMessageIdx,
        };
      }
      // Fallback for unknown types
      return {
        type: "text",
        text: `[Unknown block type: ${(block as { type: string }).type}]`,
        nativeMessageIdx,
      };
  }
}

/** We only ever need to place a cache header on the last block, since anthropic now can compute the longest reusable
 * prefix.
 * https://www.anthropic.com/news/token-saving-updates
 */
export function withCacheControl(
  messages: Anthropic.MessageParam[],
): Anthropic.MessageParam[] {
  // Find the last eligible block by searching backwards through messages
  for (
    let messageIndex = messages.length - 1;
    messageIndex >= 0;
    messageIndex--
  ) {
    const message = messages[messageIndex];
    if (typeof message.content === "string") {
      continue;
    }

    for (
      let blockIndex = message.content.length - 1;
      blockIndex >= 0;
      blockIndex--
    ) {
      const block = message.content[blockIndex];

      // Check if this block is eligible for caching
      if (
        block &&
        typeof block !== "string" &&
        block.type !== "thinking" &&
        block.type !== "redacted_thinking" &&
        !(block.type === "text" && !block.text)
      ) {
        const result = [...messages];
        // Create new array with updated message containing the cache_control block
        const newContent = [...message.content];
        newContent[blockIndex] = {
          ...block,
          cache_control: { type: "ephemeral" },
        };

        result[messageIndex] = {
          ...message,
          content: newContent,
        };
        return result;
      }
    }
  }

  return messages;
}

/** Resolve `output_config` for adaptive-thinking models. Emits a single warn
 * and returns undefined when the current model does not support adaptive
 * thinking but the caller requested an effort level. */
export function resolveOutputConfig(
  model: string,
  thinking:
    | {
        enabled: boolean;
        budgetTokens?: number;
        displayThinking?: boolean;
        effort?: "low" | "medium" | "high" | "xhigh" | "max";
      }
    | undefined,
  logger: Logger,
): Anthropic.Messages.OutputConfig | undefined {
  if (!thinking?.effort) return undefined;
  if (!supportsAdaptiveThinking(model)) {
    logger.warn(
      `thinking.effort is only supported on adaptive-thinking models (Opus 4.7+, Sonnet 4.6+); ignoring effort=${thinking.effort} on model ${model}`,
    );
    return undefined;
  }
  return { effort: thinking.effort };
}

// Opus 4.7+ and Sonnet 4.6+ require adaptive thinking instead of budget_tokens
function supportsAdaptiveThinking(model: string): boolean {
  const normalized = normalizeModelName(model);
  if (normalized.match(/^claude-opus-4-([7-9]|\d{2,})/)) return true;
  if (normalized.match(/^claude-sonnet-4-([6-9]|\d{2,})/)) return true;
  return false;
}

function normalizeModelName(model: string): string {
  const match = model.match(/claude-[a-z0-9.-]+/);
  return match ? match[0] : model;
}
export function getContextWindowForModel(model: string): number {
  model = normalizeModelName(model);
  // Claude 3+ models all have 200K context windows
  if (model.match(/^claude-(opus-4|sonnet-4|haiku-4|3|4)/)) {
    return 200_000;
  }

  // Legacy Claude 2.x models - 100K context window
  if (model.match(/^claude-2\./)) {
    return 100_000;
  }

  // Default for unknown models - conservative 200K
  return 200_000;
}
export function getMaxTokensForModel(model: string): number {
  model = normalizeModelName(model);
  // Claude 4.5 models (Opus, Sonnet, Haiku) - use high limits
  if (
    model.match(/^claude-(opus-4-5|opus-4-6|opus-4-7|sonnet-4-5|haiku-4-5)/)
  ) {
    return 32000;
  }

  // Claude 4 models - use high limits
  if (model.match(/^claude-(opus-4|sonnet-4|4-opus|4-sonnet)/)) {
    return 32000;
  }

  // Claude 3.7 Sonnet - supports up to 128k with beta header
  if (model.match(/^claude-3-7-sonnet/)) {
    return 32000; // Conservative default, can be increased to 128k with beta header
  }

  // Claude 3.5 Sonnet - 8k limit
  if (model.match(/^claude-3-5-sonnet/)) {
    return 8192;
  }

  // Claude 3.5 Haiku - 8k limit (same as Sonnet)
  if (model.match(/^claude-3-5-haiku/)) {
    return 8192;
  }

  // Legacy Claude 3 models (Opus, Sonnet, Haiku) - 4k limit
  if (model.match(/^claude-3-(opus|sonnet|haiku)/)) {
    return 4096;
  }

  // Legacy Claude 2.x models - 4k limit
  if (model.match(/^claude-2\./)) {
    return 4096;
  }

  // Default for unknown models - conservative 4k limit
  return 4096;
}

export const CLAUDE_CODE_SPOOF_PROMPT =
  "You are Claude Code, Anthropic's official CLI for Claude.";
