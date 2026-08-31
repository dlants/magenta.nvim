import { randomUUID } from "node:crypto";
import type OpenAI from "openai";
import type { Logger } from "../logger.ts";
import type { ReasoningEffort, ReasoningSummary } from "../provider-options.ts";
import type { ToolName, ToolRequestId, ValidateInput } from "../tool-types.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import {
  ABORT_TOOL_RESULT_TEXT,
  getRetryDelay,
  MAX_RETRY_DURATION,
} from "./anthropic-runner.ts";
import {
  convertResponseOutputToProviderContent,
  createStreamParameters,
  isRetryableOpenAIError,
  usageFromResponse,
} from "./openai.ts";
import type {
  AgentInput,
  AgentLog,
  AgentOptions,
  FinalizeReason,
  NativeInferenceManager,
  NativeMessageIdx,
  OnRequestUpdate,
  ProviderMessage,
  ProviderMessageContent,
  ProviderToolResult,
  RequestedTool,
  RequestResult,
  RetryStatus,
  StreamingBlock,
  StreamStopReason,
  ToolResults,
  Usage,
} from "./provider-types.ts";
import { PLACEHOLDER_NATIVE_MESSAGE_IDX } from "./provider-types.ts";
import { classifyTextContent } from "./tagged-content.ts";

type ResponseStreamEvent = OpenAI.Responses.ResponseStreamEvent;
type ResponseIncompleteReason = NonNullable<
  OpenAI.Responses.Response["incomplete_details"]
>["reason"];

/** The slice of the SDK client the agent actually uses. Declared structurally
 * so `MockOpenAIClient` satisfies it without pretending to be an `OpenAI`. */
export type OpenAIStreamingClient = {
  responses: {
    create(
      params: OpenAI.Responses.ResponseCreateParamsStreaming,
      options?: { signal?: AbortSignal },
    ): Promise<
      AsyncIterable<ResponseStreamEvent> & { controller: AbortController }
    >;
  };
};

export type OpenAIRunnerOptions = {
  includeWebSearch: boolean;
  logger: Logger;
  validateInput: ValidateInput;
  reasoning?:
    | {
        effort?: ReasoningEffort | undefined;
        summary?: ReasoningSummary | undefined;
      }
    | undefined;
};

/** Live accumulation state for one `output_index`. */
type OpenAIStreamingBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "tool_use"; id: ToolRequestId; name: ToolName; inputJson: string }
  | { type: "server_tool_use"; id: string };

type Action =
  | { type: "reset-attempt" }
  | { type: "stream-event"; event: ResponseStreamEvent }
  | {
      type: "stream-completed";
      stopReason: StreamStopReason;
      usage: Usage | undefined;
    }
  | { type: "stream-error"; error: Error }
  | { type: "stream-aborted" };

type AttemptResult =
  | {
      type: "completed";
      stopReason: StreamStopReason;
      usage: Usage | undefined;
    }
  | { type: "aborted" }
  | { type: "error"; error: Error };

export class OpenAIInferenceManager implements NativeInferenceManager {
  /** True between the start and the settling of a `sendRequest` call; the only
   * externally visible state this manager has. */
  private requestInFlight = false;
  private onRequestUpdate: OnRequestUpdate | undefined;
  /** ProviderMessage[] is the single source of truth; the request body is
   * derived from it on every turn (see `createStreamParameters`). */
  private messages: ProviderMessage[] = [];
  private latestUsage: Usage | undefined;

  /** Blocks in flight, keyed by `output_index`. The fixtures show items
   * arriving sequentially rather than interleaved, but keying on the index the
   * server supplies is free and removes the assumption. */
  private blocks = new Map<number, OpenAIStreamingBlock>();
  private openIndex: number | undefined;
  /** Completed items of the current turn, in arrival order. */
  private turnItems: OpenAI.Responses.ResponseOutputItem[] = [];
  /** Index in `messages` of the assistant message this turn is accumulating
   * into, once the first item has completed. */
  private turnMessageIdx: number | undefined;

  private stream:
    | (AsyncIterable<ResponseStreamEvent> & { controller: AbortController })
    | undefined;
  private aborted = false;
  private retryAbortController: AbortController | undefined;

  /** Stable for the life of this agent (and its clones) so every turn of the
   * conversation routes to the same prompt-cache shard. */
  private promptCacheKey = randomUUID();

  constructor(
    private options: AgentOptions,
    private client: OpenAIStreamingClient,
    private openaiOptions: OpenAIRunnerOptions,
  ) {}

  get log(): AgentLog {
    return {
      messages: this.messages,
      latestUsage: this.latestUsage,
      inputTokenCount: undefined,
    };
  }

  private notify(): void {
    queueMicrotask(() => this.options.onUpdate());
  }

  // -------------------------------------------------------------------------
  // State machine
  // -------------------------------------------------------------------------

  private update(action: Action): void {
    switch (action.type) {
      case "reset-attempt":
        // A failed attempt may have left half-accumulated items behind; the
        // retry re-sends the same history, so drop them.
        this.blocks.clear();
        this.openIndex = undefined;
        this.turnItems = [];
        if (this.turnMessageIdx !== undefined) {
          this.messages.splice(this.turnMessageIdx);
          this.turnMessageIdx = undefined;
        }
        break;

      case "stream-event":
        this.applyStreamEvent(action.event);
        break;

      case "stream-completed": {
        this.stream = undefined;
        this.commitAssistantMessage("normal");
        this.latestUsage = action.usage;
        this.attachStopInfo(action.stopReason, action.usage);
        break;
      }

      case "stream-error":
        this.stream = undefined;
        this.commitAssistantMessage("normal");
        break;

      case "stream-aborted":
        // An aborted Responses stream simply stops: no terminal event and no
        // usage, so the turn is unwound from what arrived.
        this.stream = undefined;
        this.commitAssistantMessage("aborted");
        break;

      default:
        assertUnreachable(action);
    }

    this.syncStreamingBlock();
    this.notify();
  }

  /** Report the in-progress block, normalized away from the native shape: a
   * fresh `StreamingBlock` every time, never an alias of the live block. */
  private syncStreamingBlock(): void {
    const report = this.onRequestUpdate;
    if (!report) return;
    const block =
      this.openIndex === undefined
        ? undefined
        : this.blocks.get(this.openIndex);
    let streamingBlock: StreamingBlock | undefined;
    switch (block?.type) {
      case "text":
        streamingBlock = { type: "text", text: block.text };
        break;
      case "thinking":
        streamingBlock = {
          type: "thinking",
          thinking: block.thinking,
          signature: block.signature,
        };
        break;
      case "tool_use":
        streamingBlock = {
          type: "tool_use",
          id: block.id,
          name: block.name,
          inputJson: block.inputJson,
        };
        break;
      default:
        streamingBlock = undefined;
    }
    report(
      streamingBlock
        ? { type: "streaming-block", streamingBlock }
        : { type: "block-finished" },
    );
  }

  private applyStreamEvent(event: ResponseStreamEvent): void {
    switch (event.type) {
      case "response.output_item.added": {
        const block = startBlock(event.item);
        if (block) {
          this.blocks.set(event.output_index, block);
          this.openIndex = event.output_index;
        }
        break;
      }

      case "response.output_text.delta": {
        const block = this.blocks.get(event.output_index);
        if (block?.type === "text") block.text += event.delta;
        break;
      }

      case "response.function_call_arguments.delta": {
        const block = this.blocks.get(event.output_index);
        if (block?.type === "tool_use") block.inputJson += event.delta;
        break;
      }

      case "response.reasoning_summary_part.added": {
        const block = this.blocks.get(event.output_index);
        // Summary parts are indexed independently of output items, and all of
        // them belong to the single thinking block opened for this item.
        if (block?.type === "thinking" && event.summary_index > 0) {
          block.thinking += "\n\n";
        }
        break;
      }

      case "response.reasoning_summary_text.delta": {
        const block = this.blocks.get(event.output_index);
        if (block?.type === "thinking") block.thinking += event.delta;
        break;
      }

      case "response.output_item.done": {
        this.turnItems.push(event.item);
        // Committing each item as it completes is what makes the turn render
        // incrementally; otherwise nothing is visible until the stream ends.
        this.appendTurnContent(
          convertResponseOutputToProviderContent(
            this.openaiOptions.validateInput,
            [event.item],
          ),
        );
        this.blocks.delete(event.output_index);
        if (this.openIndex === event.output_index) {
          this.openIndex = undefined;
        }
        break;
      }

      default:
        break;
    }
  }

  private appendTurnContent(content: ProviderMessageContent[]): void {
    if (content.length === 0) return;
    if (this.turnMessageIdx === undefined) {
      this.messages.push({ role: "assistant", content });
      this.turnMessageIdx = this.messages.length - 1;
    } else {
      this.messages[this.turnMessageIdx].content.push(...content);
    }
    this.restamp();
  }
  /** Close out the turn, folding in any partial block left by an abort. */
  private commitAssistantMessage(mode: "normal" | "aborted"): void {
    // An aborted stream leaves the open item without its `done` event, so the
    // partial text is only available from the live block.
    const openBlock =
      this.openIndex === undefined
        ? undefined
        : this.blocks.get(this.openIndex);
    if (openBlock?.type === "text" && openBlock.text) {
      this.appendTurnContent([
        {
          type: "text",
          text: openBlock.text,
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
        },
      ]);
    }
    this.blocks.clear();
    this.openIndex = undefined;
    this.turnItems = [];
    this.turnMessageIdx = undefined;
    if (mode === "aborted") {
      // Tool calls interrupted mid-stream are never dispatched, so they would
      // be left without a function_call_output.
      dropDanglingToolUses(this.messages);
      this.restamp();
    }
  }

  private attachStopInfo(
    stopReason: StreamStopReason,
    usage: Usage | undefined,
  ) {
    const last = this.messages[this.messages.length - 1];
    if (last && last.role === "assistant") {
      last.stopReason = stopReason;
      if (usage) last.usage = usage;
    }
  }

  /** `nativeMessageIdx` is the index of the owning message. */
  private restamp(): void {
    this.messages.forEach((message, idx) => {
      for (const content of message.content) {
        content.nativeMessageIdx = idx as NativeMessageIdx;
      }
    });
  }

  // -------------------------------------------------------------------------
  // Runner interface
  // -------------------------------------------------------------------------

  getNativeMessageIdx(): NativeMessageIdx {
    return (this.messages.length - 1) as NativeMessageIdx;
  }

  appendUserMessage(content: AgentInput[], opts?: { coalesce?: true }): void {
    if (content.length === 0) return;
    // Tagged text has to be re-tagged into its structured content type, exactly
    // as the anthropic agent does, or the view renders it as raw text.
    const classified = content.map(
      (item) =>
        (item.type === "text"
          ? classifyTextContent(item.text, item.nativeMessageIdx)
          : undefined) ?? item,
    );
    const last = this.messages[this.messages.length - 1];
    if (opts?.coalesce && last && last.role === "user") {
      last.content = [...last.content, ...classified];
    } else {
      this.messages.push({ role: "user", content: classified });
    }
    this.restamp();
    this.notify();
  }

  /** Every requested tool gets exactly one result block. Ids the executor
   * omitted are answered here rather than trusted to the executor. Parallel
   * tool calls produce several results for one assistant message; they
   * accumulate into a single trailing user message. */
  appendToolResults(
    requested: ReadonlyArray<RequestedTool>,
    results: ToolResults,
  ): void {
    for (const { id } of requested) {
      const result: ProviderToolResult = {
        type: "tool_result",
        id,
        result: results.get(id) ?? {
          status: "error",
          error: ABORT_TOOL_RESULT_TEXT,
        },
        nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
      };
      const last = this.messages[this.messages.length - 1];
      if (last && last.role === "user") {
        last.content.push(result);
      } else {
        this.messages.push({ role: "user", content: [result] });
      }
    }
    this.restamp();
    this.notify();
  }

  abort(): void {
    if (!this.requestInFlight) return;
    this.aborted = true;
    this.retryAbortController?.abort();
    this.stream?.controller.abort();
  }

  truncateMessages(messageIdx: NativeMessageIdx): void {
    this.messages.length = Math.max(
      0,
      Math.min(messageIdx + 1, this.messages.length),
    );
    dropDanglingToolUses(this.messages);
    this.restamp();
    this.notify();
  }

  clone(): OpenAIInferenceManager {
    const cloned = new OpenAIInferenceManager(
      this.options,
      this.client,
      this.openaiOptions,
    );
    cloned.promptCacheKey = this.promptCacheKey;
    cloned.messages = structuredClone(this.messages);
    dropDanglingToolUses(cloned.messages);
    cloned.restamp();
    cloned.latestUsage = this.latestUsage ? { ...this.latestUsage } : undefined;
    return cloned;
  }

  // -------------------------------------------------------------------------
  // Streaming
  // -------------------------------------------------------------------------

  /** The tool_use blocks of the assistant message we just finished streaming. */
  private collectRequestedTools(): RequestedTool[] {
    const last = this.messages[this.messages.length - 1];
    if (!last || last.role !== "assistant") return [];
    return last.content
      .filter((block) => block.type === "tool_use")
      .map((block) => ({ id: block.id, request: block.request }));
  }

  /** One provider request, including the retry/backoff budget. */
  async sendRequest(onUpdate: OnRequestUpdate): Promise<RequestResult> {
    if (this.requestInFlight) {
      throw new Error(
        "sendRequest called while a request is already in flight",
      );
    }
    this.requestInFlight = true;
    this.aborted = false;
    this.onRequestUpdate = onUpdate;
    try {
      const outcome = await this.streamOneResponse();
      if (outcome.type === "completed") {
        return {
          type: "completed",
          stopReason: outcome.stopReason,
          requested: this.collectRequestedTools(),
        };
      }
      return outcome;
    } finally {
      this.requestInFlight = false;
      this.onRequestUpdate = undefined;
      this.stream = undefined;
    }
  }

  finalize(reason: FinalizeReason): void {
    if (reason.type === "aborted") {
      this.update({ type: "stream-aborted" });
    } else {
      this.update({ type: "stream-error", error: reason.error });
    }
  }

  /** One provider response, including the retry/backoff budget. Retries are
   * internal to the request and never surface as a phase transition. */
  private async streamOneResponse(): Promise<AttemptResult> {
    const startTime = new Date();
    this.blocks.clear();
    this.turnMessageIdx = undefined;
    this.openIndex = undefined;
    this.turnItems = [];

    const attempt = async (): Promise<AttemptResult> => {
      const params = createStreamParameters({
        model: this.options.model,
        messages: this.messages,
        tools: this.options.tools,
        systemPrompt: this.options.systemPrompt,
        includeWebSearch: this.openaiOptions.includeWebSearch,
        reasoning: this.openaiOptions.reasoning,
        promptCacheKey: this.promptCacheKey,
      });

      try {
        const stream = await this.client.responses.create(params);
        this.stream = stream;
        let usage: Usage | undefined;
        let incompleteReason: ResponseIncompleteReason | undefined;
        for await (const event of stream) {
          this.update({ type: "stream-event", event });
          if (event.type === "response.completed") {
            usage = usageFromResponse(event.response);
          } else if (event.type === "response.incomplete") {
            usage = usageFromResponse(event.response);
            incompleteReason = event.response.incomplete_details?.reason;
          } else if (event.type === "response.failed") {
            return {
              type: "error",
              error: new Error(
                event.response.error?.message ?? "response.failed",
              ),
            };
          } else if (event.type === "error") {
            return { type: "error", error: new Error(event.message) };
          }
        }

        if (this.aborted) return { type: "aborted" };

        if (!usage) {
          // The stream ended without a terminal event: a cancellation, which
          // the backend signals only by closing the connection.
          return { type: "aborted" };
        }

        return {
          type: "completed",
          stopReason: this.deriveStopReason(incompleteReason),
          usage,
        };
      } catch (error) {
        if (this.aborted) return { type: "aborted" };
        return {
          type: "error",
          error: error instanceof Error ? error : new Error(String(error)),
        };
      }
    };

    let attemptNum = 0;
    while (true) {
      this.onRequestUpdate?.({ type: "attempt-started" });

      const result = await attempt();

      if (result.type === "completed") {
        this.update({
          type: "stream-completed",
          stopReason: result.stopReason,
          usage: result.usage,
        });
        return result;
      }

      if (result.type === "aborted") return result;

      const elapsed = Date.now() - startTime.getTime();
      if (
        !isRetryableOpenAIError(result.error) ||
        elapsed >= MAX_RETRY_DURATION
      ) {
        return result;
      }

      const delay = getRetryDelay(attemptNum);
      const retry: RetryStatus = {
        attempt: attemptNum + 1,
        nextRetryAt: new Date(Date.now() + delay),
        error: result.error,
      };
      this.onRequestUpdate?.({ type: "retry-scheduled", retry });

      this.retryAbortController = new AbortController();
      const signal = this.retryAbortController.signal;
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, delay);
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(new Error("aborted"));
            },
            { once: true },
          );
        });
      } catch {
        this.retryAbortController = undefined;
        return { type: "aborted" };
      }
      this.retryAbortController = undefined;
      this.update({ type: "reset-attempt" });
      attemptNum++;
    }
  }

  private deriveStopReason(
    incompleteReason: ResponseIncompleteReason | undefined,
  ): StreamStopReason {
    if (incompleteReason === "max_output_tokens") return "max_tokens";
    if (incompleteReason === "content_filter") return "content";
    if (this.turnItems.some((item) => item.type === "function_call")) {
      return "tool_use";
    }
    return "end_turn";
  }
}

function startBlock(
  item: OpenAI.Responses.ResponseOutputItem,
): OpenAIStreamingBlock | undefined {
  switch (item.type) {
    case "message":
      return { type: "text", text: "" };
    case "function_call":
      return {
        type: "tool_use",
        id: item.call_id as ToolRequestId,
        name: item.name as ToolName,
        inputJson: "",
      };
    case "reasoning":
      return { type: "thinking", thinking: "", signature: "" };
    case "web_search_call":
      return { type: "server_tool_use", id: item.id };
    default:
      return undefined;
  }
}

/** Remove tool_use blocks with no matching tool_result. The backend rejects a
 * `function_call` that is not answered by a `function_call_output`. */
function dropDanglingToolUses(messages: ProviderMessage[]): void {
  const answered = new Set<string>();
  for (const message of messages) {
    for (const content of message.content) {
      if (content.type === "tool_result") answered.add(content.id);
    }
  }

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    message.content = message.content.filter(
      (content) => content.type !== "tool_use" || answered.has(content.id),
    );
    if (message.content.length === 0) messages.splice(i, 1);
  }
}
