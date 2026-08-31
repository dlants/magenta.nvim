import { randomUUID } from "node:crypto";
import type OpenAI from "openai";
import type { Logger } from "../logger.ts";
import type { ReasoningEffort, ReasoningSummary } from "../provider-options.ts";
import type { ToolName, ToolRequestId, ValidateInput } from "../tool-types.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import {
  describeError,
  flattenError,
  isAuthError,
  type RefreshAuth,
} from "./auth-refresh.ts";
import {
  ABORT_TOOL_RESULT_TEXT,
  getRetryDelay,
  MAX_RETRY_DURATION,
} from "./inference-shared.ts";
import {
  convertInputToNativeItems,
  createStreamParameters,
  isRetryableOpenAIError,
  usageFromResponse,
} from "./openai.ts";
import {
  convertOpenAIItemsToProvider,
  type ItemStopInfo,
  roleOf,
} from "./openai-conversion.ts";
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
  RetryStatus,
  StreamingBlock,
  StreamStopReason,
  ToolResults,
  Usage,
} from "./provider-types.ts";

type Item = OpenAI.Responses.ResponseInputItem;

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

export type OpenAIInferenceOptions = {
  includeWebSearch: boolean;
  logger: Logger;
  validateInput: ValidateInput;
  /** Bedrock-only: refreshes AWS credentials after an auth error. */
  refreshAuth?: RefreshAuth | undefined;
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
      usage: Usage;
    }
  | { type: "stream-error"; error: Error }
  | { type: "stream-aborted" };

type AttemptResult =
  | {
      type: "completed";
      stopReason: StreamStopReason;
      usage: Usage;
    }
  | { type: "aborted" }
  | { type: "error"; error: Error };

export class OpenAIInferenceManager implements NativeInferenceManager {
  /** The whole of this manager's externally visible state: whether a
   * `sendRequest` call is in flight, and whether it has been aborted. Abort is
   * only meaningful during a request, so it lives inside the running variant. */
  private request: { type: "idle" } | { type: "running"; aborted: boolean } = {
    type: "idle",
  };
  private onRequestUpdate: OnRequestUpdate | undefined;
  /** The native Responses input items are the single source of truth. The
   * request body is these items verbatim; `ProviderMessage[]` is derived from
   * them and never converted back. */
  private items: Item[] = [];
  private cachedProviderMessages: ProviderMessage[] = [];
  /** Stop reason and usage for an assistant turn, keyed by the index of the
   * turn's last item. The wire format has no field for it. */
  private stopInfo = new Map<NativeMessageIdx, ItemStopInfo>();
  private latestUsage: Usage | undefined;

  /** Blocks in flight, keyed by `output_index`. The fixtures show items
   * arriving sequentially rather than interleaved, but keying on the index the
   * server supplies is free and removes the assumption. */
  private blocks = new Map<number, OpenAIStreamingBlock>();
  private openIndex: number | undefined;
  /** Index in `items` of the first item of the turn being accumulated. */
  private turnStartIdx = 0;

  private stream:
    | (AsyncIterable<ResponseStreamEvent> & { controller: AbortController })
    | undefined;
  private retryAbortController: AbortController | undefined;

  /** Stable for the life of this agent (and its clones) so every turn of the
   * conversation routes to the same prompt-cache shard. */
  private promptCacheKey = randomUUID();

  constructor(
    private options: InferenceOptions,
    private client: OpenAIStreamingClient,
    private openaiOptions: OpenAIInferenceOptions,
  ) {}

  get log(): AgentLog {
    return {
      messages: this.cachedProviderMessages,
      latestUsage: this.latestUsage,
    };
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
        this.items.length = this.turnStartIdx;
        this.pruneStopInfo();
        this.updateCache();
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
        // A completed output item is assignable to an input item, so it is
        // appended verbatim: ids, encrypted_content and summary parts survive
        // byte-for-byte into the next request. Committing each item as it
        // completes is also what makes the turn render incrementally.
        this.items.push(event.item);
        this.updateCache();
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

  /** Close out the turn, folding in any partial block left by an abort. */
  private commitAssistantMessage(mode: "normal" | "aborted"): void {
    // An aborted stream leaves the open item without its `done` event, so the
    // partial text is only available from the live block. It has no server id,
    // so it goes back as an easy assistant message.
    const openBlock =
      this.openIndex === undefined
        ? undefined
        : this.blocks.get(this.openIndex);
    if (openBlock?.type === "text" && openBlock.text) {
      this.items.push({ role: "assistant", content: openBlock.text });
    }
    this.blocks.clear();
    this.openIndex = undefined;
    if (mode === "aborted") {
      // Tool calls interrupted mid-stream are never dispatched, so they would
      // be left without a function_call_output.
      this.pruneItems();
    }
    this.updateCache();
  }

  private attachStopInfo(stopReason: StreamStopReason, usage: Usage) {
    const idx = (this.items.length - 1) as NativeMessageIdx;
    if (idx < this.turnStartIdx) return;
    this.stopInfo.set(idx, { stopReason, usage });
    this.updateCache();
  }

  private updateCache(): void {
    this.cachedProviderMessages = convertOpenAIItemsToProvider(
      this.openaiOptions.validateInput,
      this.items,
      this.stopInfo,
    );
  }

  private pruneStopInfo(): void {
    for (const idx of this.stopInfo.keys()) {
      if (idx >= this.items.length) this.stopInfo.delete(idx);
    }
  }

  /** Enforce the two shapes the backend rejects: a `function_call` with no
   * matching `function_call_output`, and a `reasoning` item left stranded by
   * that removal (reasoning must be followed by the output it reasons about).
   * Indices shift, so `stopInfo` is remapped rather than pruned. */
  private pruneItems(): void {
    const answered = new Set<string>();
    for (const item of this.items) {
      if (item.type === "function_call_output") answered.add(item.call_id);
    }

    const keep = this.items.map(() => true);
    let assistantFollows = false;
    for (let i = this.items.length - 1; i >= 0; i--) {
      const item = this.items[i];
      if (item.type === "function_call" && !answered.has(item.call_id)) {
        keep[i] = false;
        continue;
      }
      if (item.type === "reasoning" && !assistantFollows) {
        keep[i] = false;
        continue;
      }
      const role = roleOf(item);
      if (role === "assistant") assistantFollows = true;
      else if (role === "user") assistantFollows = false;
    }
    if (keep.every(Boolean)) return;

    const remap = new Map<NativeMessageIdx, NativeMessageIdx>();
    const next: Item[] = [];
    this.items.forEach((item, i) => {
      if (!keep[i]) return;
      remap.set(i as NativeMessageIdx, next.length as NativeMessageIdx);
      next.push(item);
    });
    this.items = next;
    this.stopInfo = new Map(
      [...this.stopInfo].flatMap(([idx, info]) => {
        const moved = remap.get(idx);
        return moved === undefined ? [] : [[moved, info] as const];
      }),
    );
  }

  // -------------------------------------------------------------------------
  // Runner interface
  // -------------------------------------------------------------------------

  getNativeMessageIdx(): NativeMessageIdx {
    return (this.items.length - 1) as NativeMessageIdx;
  }

  appendUserMessage(content: AgentInput[], opts?: { coalesce?: true }): void {
    if (content.length === 0) return;
    // Tagged text is stored on the wire as plain input_text and re-tagged by
    // the display conversion, so nothing is classified here.
    const native = convertInputToNativeItems(content);
    if (native.length === 0) return;
    const lastUser = userMessageContent(this.items[this.items.length - 1]);
    if (opts?.coalesce && lastUser) {
      lastUser.push(...native[0].content);
    } else {
      this.items.push(...native);
    }
    this.updateCache();
  }

  /** Every requested tool gets exactly one result block. Ids the executor
   * omitted are answered here rather than trusted to the executor. Parallel
   * tool calls produce several results for one assistant message; they
   * accumulate into a single trailing user message. */
  appendToolResults(
    requested: ReadonlyArray<RequestedTool>,
    results: ToolResults,
  ): void {
    const attachments: OpenAI.Responses.ResponseInputContent[] = [];
    for (const { id } of requested) {
      const result = results.get(id) ?? {
        status: "error" as const,
        error: ABORT_TOOL_RESULT_TEXT,
      };
      this.items.push({
        type: "function_call_output",
        call_id: id,
        output: toolResultOutput(result, attachments),
      });
    }
    // Images and documents cannot ride inside a function_call_output, so they
    // follow it as a user message.
    if (attachments.length) {
      this.items.push({ type: "message", role: "user", content: attachments });
    }
    this.updateCache();
  }

  private get isAborted(): boolean {
    return this.request.type === "running" && this.request.aborted;
  }

  abort(): void {
    if (this.request.type !== "running") return;
    this.request.aborted = true;
    this.retryAbortController?.abort();
    this.stream?.controller.abort();
  }

  truncateMessages(messageIdx: NativeMessageIdx): void {
    this.items.length = Math.max(
      0,
      Math.min(messageIdx + 1, this.items.length),
    );
    this.pruneStopInfo();
    this.pruneItems();
    this.updateCache();
  }

  clone(): OpenAIInferenceManager {
    const cloned = new OpenAIInferenceManager(
      this.options,
      this.client,
      this.openaiOptions,
    );
    cloned.promptCacheKey = this.promptCacheKey;
    cloned.items = structuredClone(this.items) as Item[];
    cloned.stopInfo = new Map(this.stopInfo);
    cloned.pruneItems();
    cloned.updateCache();
    cloned.latestUsage = this.latestUsage ? { ...this.latestUsage } : undefined;
    return cloned;
  }

  // -------------------------------------------------------------------------
  // Streaming
  // -------------------------------------------------------------------------

  /** The tool_use blocks of the assistant message we just finished streaming. */
  private collectRequestedTools(): RequestedTool[] {
    const last =
      this.cachedProviderMessages[this.cachedProviderMessages.length - 1];
    if (!last || last.role !== "assistant") return [];
    return last.content
      .filter((block) => block.type === "tool_use")
      .map((block) => ({ id: block.id, request: block.request }));
  }

  /** One provider request, including the retry/backoff budget. */
  async sendRequest(onUpdate: OnRequestUpdate): Promise<RequestResult> {
    if (this.request.type === "running") {
      throw new Error(
        "sendRequest called while a request is already in flight",
      );
    }
    this.request = { type: "running", aborted: false };
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
      this.request = { type: "idle" };
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
    this.openIndex = undefined;
    this.turnStartIdx = this.items.length;

    const attempt = async (): Promise<AttemptResult> => {
      const params = createStreamParameters({
        model: this.options.model,
        input: this.items,
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

        if (this.isAborted) return { type: "aborted" };

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
        if (this.isAborted) return { type: "aborted" };
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

      // Auth-error path: refresh credentials and retry immediately, outside the
      // 429/5xx retry budget. The 30s guard inside refreshAuth prevents tight
      // loops.
      const refreshAuth = this.openaiOptions.refreshAuth;
      if (refreshAuth && isAuthError(result.error)) {
        try {
          await refreshAuth();
          this.update({ type: "reset-attempt" });
          continue;
        } catch (refreshErr) {
          const refreshMessage =
            refreshErr instanceof Error
              ? refreshErr.message
              : String(refreshErr);
          return {
            type: "error",
            error: new Error(
              `Auth refresh failed: ${refreshMessage}. Original error: ${describeError(result.error)}`,
            ),
          };
        }
      }

      const elapsed = Date.now() - startTime.getTime();
      if (
        !isRetryableOpenAIError(result.error) ||
        elapsed >= MAX_RETRY_DURATION
      ) {
        // The surfaced error carries any wrapped cause in its message, since
        // the SDK collapses fetch-layer failures into "Connection error.".
        return { type: "error", error: flattenError(result.error) };
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
    if (
      this.items
        .slice(this.turnStartIdx)
        .some((item) => item.type === "function_call")
    ) {
      return "tool_use";
    }
    return "end_turn";
  }
}

/** The content list of a trailing user message, which is where a coalescing
 * append adds its parts. */
function userMessageContent(
  item: Item | undefined,
): OpenAI.Responses.ResponseInputContent[] | undefined {
  if (!item || item.type !== "message" || item.role !== "user") {
    return undefined;
  }
  return Array.isArray(item.content) ? item.content : undefined;
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

/** A `function_call_output` carries text only; attachments are collected into
 * `attachments` to be sent as the user message that follows it. */
function toolResultOutput(
  result: ProviderToolResult["result"],
  attachments: OpenAI.Responses.ResponseInputContent[],
): string {
  if (result.status === "error") return result.error;
  const textParts: string[] = [];
  for (const content of result.value) {
    switch (content.type) {
      case "text":
        textParts.push(content.text);
        break;
      case "image":
        attachments.push({
          type: "input_image",
          detail: "auto",
          image_url: `data:${content.source.media_type};base64,${content.source.data}`,
        });
        break;
      case "document":
        attachments.push({
          type: "input_file",
          filename: content.title || "untitled.pdf",
          file_data: `data:${content.source.media_type};base64,${content.source.data}`,
        });
        break;
      default:
        assertUnreachable(content);
    }
  }
  return (
    textParts.join("\n") || (attachments.length ? "Attachment follows:" : "")
  );
}
