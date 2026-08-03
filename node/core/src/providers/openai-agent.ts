import type OpenAI from "openai";
import { Emitter } from "../emitter.ts";
import type { Logger } from "../logger.ts";
import type { ReasoningEffort, ReasoningSummary } from "../provider-options.ts";
import type { ToolName, ToolRequestId, ValidateInput } from "../tool-types.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import { getRetryDelay, MAX_RETRY_DURATION } from "./anthropic-agent.ts";
import {
  convertResponseOutputToProviderContent,
  createStreamParameters,
  isRetryableOpenAIError,
  usageFromResponse,
} from "./openai.ts";
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
  ProviderMessageContent,
  ProviderToolResult,
  StopReason,
  Usage,
} from "./provider-types.ts";
import { PLACEHOLDER_NATIVE_MESSAGE_IDX } from "./provider-types.ts";

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

export type OpenAIAgentOptions = {
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
  | { type: "start-streaming"; startTime: Date }
  | { type: "reset-attempt" }
  | { type: "stream-event"; event: ResponseStreamEvent }
  | {
      type: "stream-completed";
      stopReason: StopReason;
      usage: Usage | undefined;
    }
  | { type: "stream-error"; error: Error }
  | { type: "stream-aborted" };

type AttemptResult =
  | { type: "completed"; stopReason: StopReason; usage: Usage | undefined }
  | { type: "aborted" }
  | { type: "error"; error: Error };

export class OpenAIAgent extends Emitter<AgentEvents> implements Agent {
  /** ProviderMessage[] is the single source of truth; the request body is
   * derived from it on every turn (see `createStreamParameters`). */
  private messages: ProviderMessage[] = [];
  private status: AgentStatus = { type: "stopped", stopReason: "end_turn" };
  private latestUsage: Usage | undefined;

  /** Blocks in flight, keyed by `output_index`. The fixtures show items
   * arriving sequentially rather than interleaved, but keying on the index the
   * server supplies is free and removes the assumption. */
  private blocks = new Map<number, OpenAIStreamingBlock>();
  private openIndex: number | undefined;
  /** Completed items of the current turn, in arrival order. */
  private turnItems: OpenAI.Responses.ResponseOutputItem[] = [];

  private stream:
    | (AsyncIterable<ResponseStreamEvent> & { controller: AbortController })
    | undefined;
  private aborted = false;
  private retryAbortController: AbortController | undefined;
  private streamingEndPromise: Promise<void> | undefined;
  private streamingEndResolver: (() => void) | undefined;
  private tickInterval: ReturnType<typeof setInterval> | undefined;

  constructor(
    private options: AgentOptions,
    private client: OpenAIStreamingClient,
    private openaiOptions: OpenAIAgentOptions,
  ) {
    super();
  }

  private emitAsync<K extends keyof AgentEvents>(
    event: K,
    ...args: AgentEvents[K]
  ): void {
    queueMicrotask(() => {
      this.emit(event, ...args);
    });
  }

  // -------------------------------------------------------------------------
  // State machine
  // -------------------------------------------------------------------------

  private update(action: Action): void {
    if (action.type === "stream-event" && this.status.type === "streaming") {
      this.status = { ...this.status, lastEventTime: new Date() };
    }

    switch (action.type) {
      case "start-streaming":
        this.aborted = false;
        this.status = {
          type: "streaming",
          startTime: action.startTime,
          lastEventTime: new Date(),
        };
        this.blocks.clear();
        this.openIndex = undefined;
        this.turnItems = [];
        this.streamingEndPromise = new Promise<void>((resolve) => {
          this.streamingEndResolver = resolve;
        });
        break;

      case "reset-attempt":
        // A failed attempt may have left half-accumulated items behind; the
        // retry re-sends the same history, so drop them.
        this.blocks.clear();
        this.openIndex = undefined;
        this.turnItems = [];
        break;

      case "stream-event":
        this.applyStreamEvent(action.event);
        break;

      case "stream-completed": {
        this.stream = undefined;
        this.commitAssistantMessage("normal");
        this.latestUsage = action.usage;
        this.attachStopInfo(action.stopReason, action.usage);
        this.status = { type: "stopped", stopReason: action.stopReason };
        this.resolveStreamingEnd();
        this.emitAsync("stopped", action.stopReason, action.usage);
        break;
      }

      case "stream-error":
        this.stream = undefined;
        this.commitAssistantMessage("normal");
        this.status = { type: "error", error: action.error };
        this.resolveStreamingEnd();
        this.emitAsync("error", action.error);
        break;

      case "stream-aborted":
        // An aborted Responses stream simply stops: no terminal event and no
        // usage, so the stopped state is synthesized from what arrived.
        this.stream = undefined;
        this.commitAssistantMessage("aborted");
        this.status = { type: "stopped", stopReason: "aborted" };
        this.resolveStreamingEnd();
        this.emitAsync("stopped", "aborted", undefined);
        break;

      default:
        assertUnreachable(action);
    }

    this.emitAsync("didUpdate");
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

  /** Fold the turn's completed items (plus any partial block left by an abort)
   * into an assistant message. */
  private commitAssistantMessage(mode: "normal" | "aborted"): void {
    const content: ProviderMessageContent[] =
      convertResponseOutputToProviderContent(
        this.openaiOptions.validateInput,
        this.turnItems,
      );

    // An aborted stream leaves the open item without its `done` event, so the
    // partial text is only available from the live block.
    const openBlock =
      this.openIndex === undefined
        ? undefined
        : this.blocks.get(this.openIndex);
    if (openBlock?.type === "text" && openBlock.text) {
      content.push({
        type: "text",
        text: openBlock.text,
        nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
      });
    }

    this.blocks.clear();
    this.openIndex = undefined;
    this.turnItems = [];

    if (content.length === 0) return;

    this.messages.push({ role: "assistant", content });
    if (mode === "aborted") {
      // Tool calls interrupted mid-stream are never dispatched, so they would
      // be left without a function_call_output.
      dropDanglingToolUses(this.messages);
    }
    this.restamp();
  }

  private attachStopInfo(stopReason: StopReason, usage: Usage | undefined) {
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
  // Agent interface
  // -------------------------------------------------------------------------

  getState(): AgentState {
    return {
      status: this.status,
      messages: this.messages,
      streamingBlock: this.getStreamingBlock(),
      latestUsage: this.latestUsage,
    };
  }

  getStreamingBlock(): AgentStreamingBlock | undefined {
    if (this.openIndex === undefined) return undefined;
    const block = this.blocks.get(this.openIndex);
    if (!block) return undefined;
    switch (block.type) {
      case "text":
        return { type: "text", text: block.text };
      case "thinking":
        return {
          type: "thinking",
          thinking: block.thinking,
          signature: block.signature,
        };
      case "tool_use":
        return {
          type: "tool_use",
          id: block.id,
          name: block.name,
          inputJson: block.inputJson,
        };
      case "server_tool_use":
        return undefined;
      default:
        return assertUnreachable(block);
    }
  }

  getNativeMessageIdx(): NativeMessageIdx {
    return (this.messages.length - 1) as NativeMessageIdx;
  }

  appendUserMessage(content: AgentInput[]): void {
    this.messages.push({ role: "user", content: [...content] });
    this.restamp();
    this.emitAsync("didUpdate");
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

    const assistant = this.lastAssistantMessage();
    const hasMatchingToolUse = assistant?.content.some(
      (block) => block.type === "tool_use" && block.id === toolUseId,
    );
    if (!hasMatchingToolUse) {
      throw new Error(
        `Cannot provide tool result: no tool_use block with id ${toolUseId} found in assistant message`,
      );
    }

    // Parallel tool calls produce several results for one assistant message;
    // they accumulate into the single trailing user message.
    const last = this.messages[this.messages.length - 1];
    if (last && last.role === "user") {
      last.content.push(result);
    } else {
      this.messages.push({ role: "user", content: [result] });
    }
    this.restamp();
    this.emitAsync("didUpdate");
  }

  private lastAssistantMessage(): ProviderMessage | undefined {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const message = this.messages[i];
      if (message.role === "assistant") return message;
      if (message.role !== "user") return undefined;
    }
    return undefined;
  }

  abort(): Promise<void> {
    this.aborted = true;
    this.retryAbortController?.abort();
    this.stream?.controller.abort();
    return this.streamingEndPromise || Promise.resolve();
  }

  abortToolUse(): void {
    if (
      this.status.type !== "stopped" ||
      this.status.stopReason !== "tool_use"
    ) {
      throw new Error(
        `Cannot abort tool use: expected status stopped with stopReason tool_use, but got ${JSON.stringify(this.status)}`,
      );
    }
    this.status = { type: "stopped", stopReason: "aborted" };
    this.emitAsync("stopped", "aborted", undefined);
    this.emitAsync("didUpdate");
  }

  truncateMessages(messageIdx: NativeMessageIdx): void {
    this.messages.length = Math.max(
      0,
      Math.min(messageIdx + 1, this.messages.length),
    );
    dropDanglingToolUses(this.messages);
    this.restamp();
    this.status = { type: "stopped", stopReason: "end_turn" };
    this.emitAsync("stopped", "end_turn", undefined);
    this.emitAsync("didUpdate");
  }

  clone(): OpenAIAgent {
    const cloned = new OpenAIAgent(
      this.options,
      this.client,
      this.openaiOptions,
    );
    cloned.messages = structuredClone(this.messages);
    dropDanglingToolUses(cloned.messages);
    cloned.restamp();
    cloned.latestUsage = this.latestUsage ? { ...this.latestUsage } : undefined;
    cloned.status = { type: "stopped", stopReason: "end_turn" };
    return cloned;
  }

  // -------------------------------------------------------------------------
  // Streaming
  // -------------------------------------------------------------------------

  continueConversation(): void {
    const startTime = new Date();
    this.update({ type: "start-streaming", startTime });
    this.startTicker();

    const attempt = async (): Promise<AttemptResult> => {
      const params = createStreamParameters({
        model: this.options.model,
        messages: this.messages,
        tools: this.options.tools,
        systemPrompt: this.options.systemPrompt,
        includeWebSearch: this.openaiOptions.includeWebSearch,
        reasoning: this.openaiOptions.reasoning,
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

    const runWithRetry = async () => {
      let attemptNum = 0;
      while (true) {
        this.status = {
          type: "streaming",
          startTime,
          lastEventTime: new Date(),
        };
        this.emitAsync("didUpdate");

        const result = await attempt();

        if (result.type === "completed") {
          this.update({
            type: "stream-completed",
            stopReason: result.stopReason,
            usage: result.usage,
          });
          return;
        }

        if (result.type === "aborted") {
          this.update({ type: "stream-aborted" });
          return;
        }

        const elapsed = Date.now() - startTime.getTime();
        if (
          !isRetryableOpenAIError(result.error) ||
          elapsed >= MAX_RETRY_DURATION
        ) {
          this.update({ type: "stream-error", error: result.error });
          return;
        }

        const delay = getRetryDelay(attemptNum);
        this.status = {
          type: "streaming",
          startTime,
          lastEventTime: new Date(),
          retryStatus: {
            attempt: attemptNum + 1,
            nextRetryAt: new Date(Date.now() + delay),
            error: result.error,
          },
        };
        this.emitAsync("didUpdate");

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
          this.update({ type: "stream-aborted" });
          return;
        }
        this.retryAbortController = undefined;
        this.update({ type: "reset-attempt" });
        attemptNum++;
      }
    };

    void runWithRetry();
  }

  private deriveStopReason(
    incompleteReason: ResponseIncompleteReason | undefined,
  ): StopReason {
    if (incompleteReason === "max_output_tokens") return "max_tokens";
    if (incompleteReason === "content_filter") return "content";
    if (this.turnItems.some((item) => item.type === "function_call")) {
      return "tool_use";
    }
    return "end_turn";
  }

  private startTicker(): void {
    this.stopTicker();
    this.tickInterval = setInterval(() => this.emitAsync("didUpdate"), 1000);
  }

  private stopTicker(): void {
    if (this.tickInterval !== undefined) {
      clearInterval(this.tickInterval);
      this.tickInterval = undefined;
    }
  }

  private resolveStreamingEnd(): void {
    this.stopTicker();
    if (this.streamingEndResolver) {
      this.streamingEndResolver();
      this.streamingEndResolver = undefined;
    }
    this.streamingEndPromise = undefined;
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
