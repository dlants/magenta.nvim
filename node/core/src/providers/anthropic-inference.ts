import type Anthropic from "@anthropic-ai/sdk";
import { AnthropicError, APIError } from "@anthropic-ai/sdk";
import type { MessageStream } from "@anthropic-ai/sdk/lib/MessageStream.mjs";
import type { Logger } from "../logger.ts";
import type { ToolName, ToolRequestId, ValidateInput } from "../tool-types.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import {
  stripTrailingThinkingBlocks,
  withCacheControl,
} from "./anthropic-cache.ts";
import {
  convertAnthropicMessagesToProvider,
  type MessageStopInfo,
} from "./anthropic-conversion.ts";
import {
  CLAUDE_CODE_SPOOF_PROMPT,
  effortToBudgetTokens,
  getMaxTokensForModel,
  resolveOutputConfig,
  supportsAdaptiveThinking,
} from "./anthropic-models.ts";
import { isAuthError, type RefreshAuth } from "./auth-refresh.ts";
import {
  ABORT_TOOL_RESULT_TEXT,
  assertCompleteToolResults,
  getRetryDelay,
  MAX_RETRY_DURATION,
} from "./inference-shared.ts";
import type {
  AgentInput,
  AgentLog,
  FinalizeReason,
  InferenceOptions,
  NativeInferenceManager,
  NativeMessageIdx,
  OnRequestUpdate,
  ProviderMessage,
  ProviderToolResult,
  RequestedTool,
  RequestResult,
  StreamStopReason,
  ToolResults,
  Usage,
} from "./provider-types.ts";
import {
  PLACEHOLDER_NATIVE_MESSAGE_IDX,
  thinkingConfig,
} from "./provider-types.ts";

export type AnthropicInferenceOptions = {
  authType: "key" | "max" | "keychain";
  includeWebSearch: boolean;
  disableParallelToolUseFlag: boolean;
  logger: Logger;
  validateInput: ValidateInput;
  // AWS Bedrock does not support adaptive thinking or output_config.
  // When true, magenta falls back to thinking.type=enabled with budget_tokens.
  bedrock?: boolean;
  // When set, invoked on auth errors to refresh credentials before retrying.
  refreshAuth?: RefreshAuth | undefined;
};

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

type Action =
  | { type: "reset-attempt" }
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
  | { type: "stream-completed"; response: Anthropic.Message };

export function isRetryableError(error: Error): boolean {
  if (
    error instanceof APIError &&
    (error.status === 429 || error.status === 529)
  ) {
    return true;
  }

  // Mid-stream `error` events (e.g. "overloaded_error") are surfaced by the
  // Anthropic SDK as an APIError with an undefined `status` but with the
  // error body's type set on `error.type`. These are transient, so retry.
  if (
    error instanceof APIError &&
    (error.type === "overloaded_error" || error.type === "api_error")
  ) {
    return true;
  }

  // AWS Bedrock occasionally emits a stream `error` event before `message_start`,
  // which the Anthropic SDK surfaces as this AnthropicError. It is transient
  // (typically throttling/internal errors during stream connect), so retry.
  if (
    error instanceof AnthropicError &&
    /Unexpected event order, got .* before "message_start"/.test(error.message)
  ) {
    return true;
  }
  // AWS Bedrock occasionally closes the SSE stream cleanly without emitting
  // any events at all, which the Anthropic SDK surfaces as this AnthropicError.
  // This is a transient connection glitch, so retry.
  if (
    error instanceof AnthropicError &&
    error.message === "request ended without sending any chunks"
  ) {
    return true;
  }
  // Transient SSE-decode failures: the Anthropic SDK strictly JSON.parses each
  // raw SSE event, and upstream transports (proxies, Bedrock, Azure Foundry)
  // occasionally deliver truncated or merged frames. These surface as a
  // SyntaxError that the SDK wraps in an AnthropicError. They are not
  // reproducible content errors, so retrying the turn is safe.
  if (isSSEParseError(error)) {
    return true;
  }
  // Stream-ordering invariant violations from our own block-tracking state
  // machine. These fire when upstream transports drop or reorder SSE frames
  // (e.g. a content_block_start without the preceding content_block_stop).
  // They are transient transport anomalies, not reproducible content errors,
  // so retrying the turn is safe.
  if (isStreamOrderError(error)) {
    return true;
  }
  // Generic connection-drop errors: Node/undici's fetch implementation
  // surfaces an abrupt socket/connection close (e.g. network cable pulled,
  // VPN drop, load balancer idle-timeout) as a bare Error/TypeError whose
  // message is exactly "terminated". This carries no information about the
  // request content, so it's safe (and desirable) to retry.
  if (error.message === "terminated") {
    return true;
  }
  return false;
}

const SSE_JSON_PARSE_MESSAGE =
  /Unexpected end of JSON input|in JSON at position|after JSON|Unexpected token .* in JSON|Could not parse message into JSON/;

export function isSSEParseError(error: Error): boolean {
  return (
    (error instanceof SyntaxError || error instanceof AnthropicError) &&
    SSE_JSON_PARSE_MESSAGE.test(error.message)
  );
}

const STREAM_ORDER_MESSAGE = /Received content_block_(start|delta|stop)/;

export function isStreamOrderError(error: Error): boolean {
  return STREAM_ORDER_MESSAGE.test(error.message);
}

/** This class only ever writes block arrays, never the bare-string `content`
 * form Anthropic's `MessageParam` also permits. */
type NativeMessage = Omit<Anthropic.MessageParam, "content"> & {
  content: Anthropic.Messages.ContentBlockParam[];
};

export class AnthropicInferenceManager implements NativeInferenceManager {
  private messages: NativeMessage[] = [];
  private currentRequest: MessageStream | undefined;
  private params: Omit<Anthropic.Messages.MessageStreamParams, "messages">;
  private currentAnthropicBlock: AnthropicStreamingBlock | undefined;
  private latestUsage: Usage | undefined;
  /** Stop info for each assistant message, keyed by message index */
  private messageStopInfo: Map<number, MessageStopInfo> = new Map();
  /** Cached provider messages to avoid expensive conversion on every read */
  private cachedProviderMessages: ProviderMessage[] = [];
  /** Current block index during streaming, -1 when not streaming a block */
  private currentBlockIndex: number = -1;
  /** Assistant message being built during streaming */
  private currentAssistantMessage: NativeMessage | undefined;
  /** Stored for cloning */
  private anthropicOptions: AnthropicInferenceOptions;
  private retryAbortController: AbortController | undefined;
  /** True between the start and the settling of a `sendRequest` call; the only
   * externally-visible state this class has. */
  private requestInFlight = false;
  /** Where stream progress goes while a request is in flight. */
  private onRequestUpdate: OnRequestUpdate | undefined;

  constructor(
    private options: InferenceOptions,
    private client: Anthropic,
    anthropicOptions: AnthropicInferenceOptions,
  ) {
    this.anthropicOptions = anthropicOptions;
    this.params = this.createNativeStreamParameters(anthropicOptions);
  }

  get log(): AgentLog {
    return {
      messages: this.cachedProviderMessages,
      latestUsage: this.latestUsage,
    };
  }

  private update(action: Action): void {
    switch (action.type) {
      case "reset-attempt": {
        // A previous streaming attempt may have errored mid-block, leaving a
        // partially-accumulated assistant message in this.messages and an open
        // block index. Before retrying we discard that partial state so the
        // fresh stream starts from a clean slate (otherwise the new
        // content_block_start collides with the still-open block index).
        if (this.currentAssistantMessage) {
          const idx = this.messages.indexOf(this.currentAssistantMessage);
          if (idx !== -1) {
            this.messages.splice(idx, 1);
          }
        }
        this.currentAssistantMessage = undefined;
        this.currentAnthropicBlock = undefined;
        this.currentBlockIndex = -1;
        break;
      }

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
        this.updateCachedProviderMessages();

        this.currentAssistantMessage = undefined;
        break;
      }

      default:
        assertUnreachable(action);
    }

    this.reportStreamingBlock();
  }
  /** Report the in-progress block, which is the only way callers observe it.
   * The `StreamingBlock` is constructed here rather than aliased: nothing
   * native may escape this class. */
  private reportStreamingBlock(): void {
    const report = this.onRequestUpdate;
    if (!report) return;
    const block = this.currentAnthropicBlock;
    switch (block?.type) {
      case "text":
        report({
          type: "streaming-block",
          streamingBlock: { type: "text", text: block.text },
        });
        break;
      case "thinking":
        report({
          type: "streaming-block",
          streamingBlock: {
            type: "thinking",
            thinking: block.thinking,
          },
        });
        break;
      case "tool_use":
        report({
          type: "streaming-block",
          streamingBlock: {
            type: "tool_use",
            id: block.id,
            name: block.name,
            inputJson: block.inputJson,
          },
        });
        break;
      default:
        report({ type: "block-finished" });
    }
  }
  /** Get a copy of the native Anthropic messages for use in context piping */
  getNativeMessages(): Anthropic.MessageParam[] {
    return [...this.messages];
  }

  getNativeMessageIdx(): NativeMessageIdx {
    return (this.messages.length - 1) as NativeMessageIdx;
  }

  abort(): void {
    if (!this.requestInFlight) return;
    // Cancel a pending retry wait and/or the in-flight request. Whether the
    // turn unwinds is `Agent`'s business, not ours.
    this.retryAbortController?.abort();
    this.currentRequest?.abort();
  }

  appendUserMessage(content: AgentInput[]): void {
    if (content.length === 0) return;
    const native = this.convertInputToNative(content);
    const last = this.messages[this.messages.length - 1];
    if (last && last.role === "user") {
      last.content = [...last.content, ...native];
    } else {
      this.messages.push({ role: "user", content: native });
    }
    this.updateCachedProviderMessages();
  }

  /** One provider request: everything from placing it to accumulating its
   * stream, including the retry budget. Retries are invisible to the caller
   * apart from the `retry` updates. */
  async sendRequest(onUpdate: OnRequestUpdate): Promise<RequestResult> {
    if (this.requestInFlight) {
      throw new Error(
        "sendRequest called while a request is already in flight",
      );
    }
    this.requestInFlight = true;
    this.onRequestUpdate = onUpdate;
    try {
      const outcome = await this.streamOneResponse();
      if (outcome.type === "completed") {
        const requested = this.collectRequestedTools();
        return requested.length
          ? { type: "tool_use", requested }
          : {
              type: "stopped",
              stopReason:
                outcome.stopReason === "tool_use"
                  ? "end_turn"
                  : outcome.stopReason,
            };
      }
      return outcome;
    } finally {
      this.requestInFlight = false;
      this.onRequestUpdate = undefined;
      this.currentRequest = undefined;
    }
  }

  /** Every requested tool gets exactly one result block; a caller that leaves
   * one unanswered has produced a log the provider will reject. */
  appendToolResults(
    requested: ReadonlyArray<RequestedTool>,
    results: ToolResults,
  ): void {
    assertCompleteToolResults(requested, results);
    for (const { id } of requested) {
      const result = results.get(id) as ProviderToolResult["result"];
      // Anthropic wants one user message per tool result.
      this.messages.push({
        role: "user",
        content: this.convertToolResultToNative(id, result),
      });
    }
    this.updateCachedProviderMessages();
  }

  /** The tool_use blocks of the assistant message we just finished streaming. */
  private collectRequestedTools(): RequestedTool[] {
    const last =
      this.cachedProviderMessages[this.cachedProviderMessages.length - 1];
    if (!last || last.role !== "assistant") return [];
    return last.content
      .filter((block) => block.type === "tool_use")
      .map((block) => ({ id: block.id, request: block.request }));
  }

  finalize(reason: FinalizeReason): void {
    this.currentRequest = undefined;
    this.cleanup(reason);
    this.currentAssistantMessage = undefined;
  }

  /** One provider response, including the retry/backoff budget. Retries stay
   * inside the `streaming` phase and are never observable as a transition. */
  private async streamOneResponse(): Promise<
    | { type: "completed"; stopReason: StreamStopReason }
    | { type: "aborted" }
    | { type: "error"; error: Error }
  > {
    const startTime = new Date();
    this.currentBlockIndex = -1;
    this.currentAssistantMessage = undefined;

    const attemptStream = (): Promise<
      | { type: "completed"; response: Anthropic.Message }
      | { type: "aborted" }
      | { type: "error"; error: Error }
    > => {
      const messagesWithCache = withCacheControl(
        stripTrailingThinkingBlocks(this.messages),
      );
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

    let attempt = 0;
    while (true) {
      // Clear retry status when starting a new attempt
      this.onRequestUpdate?.({ type: "attempt-started" });
      if (attempt > 0) {
        this.update({ type: "reset-attempt" });
      }

      const result = await attemptStream();
      this.currentRequest = undefined;

      if (result.type === "completed") {
        this.update({ type: "stream-completed", response: result.response });
        return {
          type: "completed",
          stopReason: result.response.stop_reason || "end_turn",
        };
      }
      if (result.type === "aborted") {
        return { type: "aborted" };
      }

      // result.type === "error"
      // Auth-error path: try to refresh credentials and retry immediately,
      // independent of the 429/529 retry budget. The 30s guard inside
      // refreshAuth prevents tight loops.
      const refreshAuth = this.anthropicOptions.refreshAuth;
      if (refreshAuth && isAuthError(result.error)) {
        try {
          await refreshAuth();
          continue;
        } catch (refreshErr) {
          const refreshMessage =
            refreshErr instanceof Error
              ? refreshErr.message
              : String(refreshErr);
          return {
            type: "error",
            error: new Error(
              `Auth refresh failed: ${refreshMessage}. Original error: ${result.error.message}`,
            ),
          };
        }
      }

      const elapsed = Date.now() - startTime.getTime();
      if (!isRetryableError(result.error) || elapsed >= MAX_RETRY_DURATION) {
        return { type: "error", error: result.error };
      }

      const delay = getRetryDelay(attempt);
      this.onRequestUpdate?.({
        type: "retry-scheduled",
        retry: {
          attempt: attempt + 1,
          nextRetryAt: new Date(Date.now() + delay),
          error: result.error,
        },
      });

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
        this.retryAbortController = undefined;
        return { type: "aborted" };
      }
      this.retryAbortController = undefined;
      attempt++;
    }
  }

  /** The conversation as it would be sent right now. Preflight and awaited:
   * whoever asked for it is deciding about this request. */
  async countTokens(): Promise<number> {
    const messagesWithCache = withCacheControl(
      stripTrailingThinkingBlocks(this.messages),
    );
    const countParams: Anthropic.Messages.MessageCountTokensParams = {
      model: this.params.model,
      messages: messagesWithCache,
    };
    if (this.params.system) countParams.system = this.params.system;
    if (this.params.tools) countParams.tools = this.params.tools;
    if (this.params.tool_choice)
      countParams.tool_choice = this.params.tool_choice;
    if (this.params.thinking) countParams.thinking = this.params.thinking;
    const result = await this.client.messages.countTokens(countParams);
    return result.input_tokens;
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

    this.updateCachedProviderMessages();
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

  clone(): AnthropicInferenceManager {
    const cloned = new AnthropicInferenceManager(
      this.options,
      this.client,
      this.anthropicOptions,
    );

    // Deep copy messages — during streaming, this.messages already contains
    // a reference to currentAssistantMessage with all finalized blocks
    // (but not the in-progress currentAnthropicBlock)
    cloned.messages = JSON.parse(JSON.stringify(this.messages));

    // Clean up the cloned messages to handle incomplete state
    AnthropicInferenceManager.cleanupClonedMessages(cloned.messages);

    // Deep copy messageStopInfo
    cloned.messageStopInfo = new Map(
      Array.from(this.messageStopInfo.entries()).map(([k, v]) => [
        k,
        { ...v, usage: { ...v.usage } },
      ]),
    );

    // Copy latestUsage if present
    if (this.latestUsage) {
      cloned.latestUsage = { ...this.latestUsage };
    }

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

  /** Leave the message array in a shape the provider will accept after a turn
   * ended without the model finishing: drop incomplete blocks and answer every
   * tool_use that the executor never got to. */
  private cleanup(reason: FinalizeReason): void {
    this.currentAnthropicBlock = undefined;

    const lastMessage = this.messages[this.messages.length - 1];
    if (!lastMessage || lastMessage.role !== "assistant") {
      return;
    }

    const content = lastMessage.content;
    if (typeof content === "string") {
      if (!content) this.messages.pop();
      this.updateCachedProviderMessages();
      return;
    }

    // Anthropic rejects empty text blocks, and a server_tool_use without its
    // result block, both of which aborting mid-stream can leave behind.
    lastMessage.content = content.filter((block, idx) => {
      if ((block as { type: string }).type === "server_tool_use") {
        const next = content[idx + 1];
        return (
          !!next && (next as { type: string }).type === "web_search_tool_result"
        );
      }
      if (block.type === "text" && !block.text) return false;
      if (block.type === "thinking" && !block.thinking) return false;
      return true;
    });

    if (lastMessage.content.length === 0) {
      this.messages.pop();
      this.updateCachedProviderMessages();
      return;
    }

    const unanswered = lastMessage.content.filter(
      (block) => block.type === "tool_use",
    );
    if (unanswered.length > 0) {
      const errorMessage =
        reason.type === "aborted"
          ? ABORT_TOOL_RESULT_TEXT
          : `Stream error occurred: ${reason.error.message}`;
      this.messages.push({
        role: "user",
        content: unanswered.map((block) => ({
          type: "tool_result",
          tool_use_id: block.id,
          content: errorMessage,
          is_error: true,
        })),
      });
    }

    this.updateCachedProviderMessages();
  }

  private createNativeStreamParameters(
    anthropicOptions: AnthropicInferenceOptions,
  ): Omit<Anthropic.Messages.MessageStreamParams, "messages"> {
    const { authType, includeWebSearch, disableParallelToolUseFlag } =
      anthropicOptions;
    const { model, tools, systemPrompt } = this.options;
    const thinking = thinkingConfig(this.options);

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

    const isBedrock = this.anthropicOptions.bedrock === true;
    if (thinking?.enabled) {
      if (supportsAdaptiveThinking(model, isBedrock)) {
        params.thinking = {
          type: "adaptive",
          display: thinking.displayThinking ? "summarized" : "omitted",
        };
      } else {
        const budget =
          thinking.budgetTokens ?? effortToBudgetTokens(thinking.effort);
        params.thinking = {
          type: "enabled",
          budget_tokens: budget,
        };
      }
    }

    const outputConfig = resolveOutputConfig(
      model,
      thinking,
      this.anthropicOptions.logger,
      isBedrock,
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
  ): Anthropic.Messages.ContentBlockParam[] {
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
    result: ProviderToolResult["result"],
  ): Anthropic.Messages.ContentBlockParam[] {
    if (result.status === "ok") {
      const contents: Array<
        Anthropic.Messages.TextBlockParam | Anthropic.Messages.ImageBlockParam
      > = [];

      for (const content of result.value) {
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
      for (const content of result.value) {
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
          content: result.error,
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
  }
}
