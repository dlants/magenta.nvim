import { randomUUID } from "node:crypto";
import type OpenAI from "openai";
import type { Logger } from "../logger.ts";
import type { ReasoningEffort, ReasoningSummary } from "../provider-options.ts";
import type { ToolName, ToolRequestId, ValidateInput } from "../tool-types.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import {
  ABORT_MARKER_TEXT,
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
  AgentPhase,
  NativeMessageIdx,
  ProviderMessage,
  ProviderMessageContent,
  ProviderToolResult,
  RequestedTool,
  Runner,
  RunnerHooks,
  StreamStopReason,
  ToolOutcome,
  ToolResults,
  TurnResult,
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

export class OpenAIRunner implements Runner {
  phase: AgentPhase = { type: "idle" };
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
  private tickInterval: ReturnType<typeof setInterval> | undefined;
  /** True between the start and the settling of a `runTurn` call. */
  private turnInFlight = false;

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
    if (action.type === "stream-event" && this.phase.type === "streaming") {
      this.phase.lastEventTime = new Date();
    }

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

  /** Mirror the in-progress block onto `phase`, which is the only way callers
   * observe it. */
  private syncStreamingBlock(): void {
    if (this.phase.type !== "streaming") return;
    const block =
      this.openIndex === undefined
        ? undefined
        : this.blocks.get(this.openIndex);
    switch (block?.type) {
      case "text":
        this.phase.block = { type: "text", text: block.text };
        break;
      case "thinking":
        this.phase.block = {
          type: "thinking",
          thinking: block.thinking,
          signature: block.signature,
        };
        break;
      case "tool_use":
        this.phase.block = {
          type: "tool_use",
          id: block.id,
          name: block.name,
          inputJson: block.inputJson,
        };
        break;
      default:
        this.phase.block = undefined;
    }
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
  private appendToolResults(
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
    if (!this.turnInFlight) return;
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

  clone(hooks: RunnerHooks): OpenAIRunner {
    const cloned = new OpenAIRunner(
      { ...this.options, onBeforeToolResponse: undefined, ...hooks },
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

  async runTurn(input: AgentInput[]): Promise<TurnResult> {
    if (this.turnInFlight) {
      throw new Error("runTurn called while a turn is already in flight");
    }
    this.turnInFlight = true;
    this.aborted = false;
    this.appendUserMessage(input);
    this.startTicker();
    try {
      return await this.runLoop();
    } finally {
      this.turnInFlight = false;
      this.aborted = false;
      this.stream = undefined;
      this.phase = { type: "idle" };
      this.stopTicker();
      this.notify();
    }
  }

  /** Alternates between inference and tool execution until something ends the
   * turn. This is the only thing that drives the agent forward. */
  private async runLoop(): Promise<TurnResult> {
    while (true) {
      if (this.aborted) return this.finishAbort();

      const outcome = await this.streamOneResponse();

      if (outcome.type === "aborted") return this.finishAbort();
      if (outcome.type === "error") {
        this.update({ type: "stream-error", error: outcome.error });
        return {
          type: "failed",
          error: outcome.error,
          retryable: isRetryableOpenAIError(outcome.error),
        };
      }

      const requested = this.collectRequestedTools();
      if (requested.length === 0) {
        return {
          type: "stopped",
          stopReason:
            outcome.stopReason === "tool_use" ? "end_turn" : outcome.stopReason,
        };
      }

      if (this.aborted) return this.finishAbort();

      this.phase = {
        type: "running_tools",
        requested,
        truncated: outcome.stopReason === "max_tokens",
      };
      this.options.onUpdate();

      let toolOutcome: ToolOutcome;
      try {
        toolOutcome = await this.options.executeTools(requested);
      } catch (error) {
        // A rejecting executor is still a turn that must leave every tool_use
        // answered, so fall through with no results and let the fill do it.
        this.openaiOptions.logger.error(
          `executeTools rejected: ${error instanceof Error ? error.message : String(error)}`,
        );
        toolOutcome = { type: "continue", results: new Map() };
      }

      this.appendToolResults(requested, toolOutcome.results);

      if (toolOutcome.type === "aborted") {
        this.aborted = true;
        return this.finishAbort();
      }
      if (toolOutcome.type === "suspend") return { type: "suspended" };
      if (this.aborted) return this.finishAbort();

      const extra = await this.options.onBeforeToolResponse?.({
        stopReason: outcome.stopReason,
        results: toolOutcome.results,
      });
      if (extra?.length) this.appendUserMessage(extra);
    }
  }

  /** The tool_use blocks of the assistant message we just finished streaming. */
  private collectRequestedTools(): RequestedTool[] {
    const last = this.messages[this.messages.length - 1];
    if (!last || last.role !== "assistant") return [];
    return last.content
      .filter((block) => block.type === "tool_use")
      .map((block) => ({ id: block.id, request: block.request }));
  }

  /** The single terminal abort transition: leave the history well-formed and
   * mark why it stops here. */
  private finishAbort(): TurnResult {
    this.phase = { type: "aborting" };
    this.options.onUpdate();
    this.update({ type: "stream-aborted" });
    this.appendUserMessage([
      {
        type: "text",
        text: ABORT_MARKER_TEXT,
        nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
      },
    ]);
    return { type: "aborted" };
  }

  /** One provider response, including the retry/backoff budget. Retries stay
   * inside the `streaming` phase and are never observable as a transition. */
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
      // Clear retry status when starting a new attempt
      this.phase = {
        type: "streaming",
        startedAt: startTime,
        lastEventTime: new Date(),
        block: undefined,
        retry: undefined,
      };
      this.options.onUpdate();

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
      this.phase = {
        type: "streaming",
        startedAt: startTime,
        lastEventTime: new Date(),
        block: undefined,
        retry: {
          attempt: attemptNum + 1,
          nextRetryAt: new Date(Date.now() + delay),
          error: result.error,
        },
      };
      this.options.onUpdate();

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

  private startTicker(): void {
    this.stopTicker();
    this.tickInterval = setInterval(() => this.options.onUpdate(), 1000);
  }

  private stopTicker(): void {
    if (this.tickInterval !== undefined) {
      clearInterval(this.tickInterval);
      this.tickInterval = undefined;
    }
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
