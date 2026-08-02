import type OpenAI from "openai";
import { Stream } from "openai/core/streaming.mjs";
import { pollUntil } from "../utils/async.ts";
import type { StopReason, Usage } from "./provider-types.ts";

type ResponseStreamEvent = OpenAI.Responses.ResponseStreamEvent;
type ResponseOutputItem = OpenAI.Responses.ResponseOutputItem;
type ResponseInputItem = OpenAI.Responses.ResponseInputItem;

/** Every event the SDK defines, minus the field `pushEvent` stamps itself. */
type EventInit = ResponseStreamEvent extends infer E
  ? E extends ResponseStreamEvent
    ? Omit<E, "sequence_number">
    : never
  : never;

/** A mock Responses stream that tests drive imperatively.
 *
 * Events are pushed as newline-delimited JSON through a ReadableStream into a
 * real SDK `Stream`, so consumers exercise the real parsing/iteration path
 * rather than a hand-rolled async iterator. The helper methods emit the exact
 * event sequences recorded in `fixtures/openai/` (see NOTES.md).
 */
export class MockResponseStream implements AsyncIterable<ResponseStreamEvent> {
  private readableController!: ReadableStreamDefaultController<Uint8Array>;
  private realStream: Stream<ResponseStreamEvent>;
  private _abortController = new AbortController();
  private _resolved = false;
  private outputIndex = 0;
  private sequenceNumber = 0;
  private outputItems: ResponseOutputItem[] = [];
  private _partialToolIndex: number | undefined;
  private _partialToolItemId: string | undefined;
  private _pushedEventCount = 0;
  private _closed = false;

  constructor(public params: OpenAI.Responses.ResponseCreateParamsStreaming) {
    const readable = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.readableController = controller;
      },
    });
    this.realStream = Stream.fromReadableStream<ResponseStreamEvent>(
      readable,
      this._abortController,
    );
  }

  [Symbol.asyncIterator](): AsyncIterator<ResponseStreamEvent> {
    return this.realStream[Symbol.asyncIterator]();
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

  get input(): OpenAI.Responses.ResponseInput {
    return this.params.input as OpenAI.Responses.ResponseInput;
  }

  get instructions(): string | undefined {
    return this.params.instructions ?? undefined;
  }

  /** Items of the request's `input` with the given `type`, for assertions on
   * what the provider echoed back. */
  inputItemsOfType<T extends ResponseInputItem["type"]>(
    type: T,
  ): Extract<ResponseInputItem, { type: T }>[] {
    return this.input.filter(
      (item): item is Extract<ResponseInputItem, { type: T }> =>
        item.type === type,
    );
  }

  abort(): void {
    this._resolved = true;
    this._abortController.abort();
    this.close();
  }

  private close(): void {
    if (this._closed) return;
    this._closed = true;
    try {
      this.readableController.close();
    } catch {
      // already closed
    }
  }

  private pushEvent(event: EventInit): void {
    this._pushedEventCount++;
    const withSequence = {
      ...event,
      sequence_number: this.sequenceNumber++,
    };
    this.readableController.enqueue(
      new TextEncoder().encode(`${JSON.stringify(withSequence)}\n`),
    );
  }

  /** Give the SDK's async iterator a chance to drain what has been pushed. */
  async settle(): Promise<void> {
    for (let i = 0; i < this._pushedEventCount + 2; i++) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }

  emitEvent(event: EventInit): void {
    this.pushEvent(event);
  }

  /** Emit a fully-formed item group and record the item for `finishResponse`. */
  private emitItem(
    item: ResponseOutputItem,
    body: (outputIndex: number) => void,
  ): number {
    const outputIndex = this.outputIndex++;
    this.pushEvent({
      type: "response.output_item.added",
      output_index: outputIndex,
      item: { ...item, status: "in_progress" } as ResponseOutputItem,
    });
    body(outputIndex);
    this.pushEvent({
      type: "response.output_item.done",
      output_index: outputIndex,
      item,
    });
    this.outputItems.push(item);
    return outputIndex;
  }

  streamText(
    text: string,
    options: {
      itemId?: string;
      annotations?: OpenAI.Responses.ResponseOutputText.URLCitation[];
    } = {},
  ): number {
    const itemId = options.itemId ?? `msg_mock_${this.outputIndex}`;
    const annotations = options.annotations ?? [];
    const item: ResponseOutputItem = {
      type: "message",
      id: itemId,
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text, annotations, logprobs: [] }],
    } as ResponseOutputItem;

    return this.emitItem(item, (outputIndex) => {
      this.pushEvent({
        type: "response.content_part.added",
        output_index: outputIndex,
        item_id: itemId,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      });
      this.pushEvent({
        type: "response.output_text.delta",
        output_index: outputIndex,
        item_id: itemId,
        content_index: 0,
        delta: text,
        logprobs: [],
      });
      for (const annotation of annotations) {
        this.pushEvent({
          type: "response.output_text.annotation.added",
          output_index: outputIndex,
          item_id: itemId,
          content_index: 0,
          annotation_index: 0,
          annotation,
        });
      }
      this.pushEvent({
        type: "response.output_text.done",
        output_index: outputIndex,
        item_id: itemId,
        content_index: 0,
        text,
        logprobs: [],
      });
      this.pushEvent({
        type: "response.content_part.done",
        output_index: outputIndex,
        item_id: itemId,
        content_index: 0,
        part: { type: "output_text", text, annotations },
      });
    });
  }

  /** Convenience for the annotated-message half of a search turn. */
  streamAnnotatedText(
    text: string,
    annotations: OpenAI.Responses.ResponseOutputText.URLCitation[],
  ): number {
    return this.streamText(text, { annotations });
  }

  streamToolCall(
    callId: string,
    name: string,
    input: Record<string, unknown>,
    options: { itemId?: string } = {},
  ): number {
    const itemId = options.itemId ?? `fc_mock_${this.outputIndex}`;
    const args = JSON.stringify(input);
    const item: ResponseOutputItem = {
      type: "function_call",
      id: itemId,
      call_id: callId,
      name,
      arguments: args,
      status: "completed",
    } as ResponseOutputItem;

    return this.emitItem(item, (outputIndex) => {
      this.pushEvent({
        type: "response.function_call_arguments.delta",
        output_index: outputIndex,
        item_id: itemId,
        delta: args,
      });
      this.pushEvent({
        type: "response.function_call_arguments.done",
        output_index: outputIndex,
        item_id: itemId,
        arguments: args,
      });
    });
  }

  /** Open a function_call item and stream partial argument JSON without
   * closing it, leaving it as the live streaming block. */
  streamToolCallPartial(callId: string, name: string, chunks: string[]): void {
    const outputIndex = this.outputIndex++;
    const itemId = `fc_mock_${outputIndex}`;
    this._partialToolIndex = outputIndex;
    this._partialToolItemId = itemId;

    this.pushEvent({
      type: "response.output_item.added",
      output_index: outputIndex,
      item: {
        type: "function_call",
        id: itemId,
        call_id: callId,
        name,
        arguments: "",
        status: "in_progress",
      },
    });
    this.continueToolCallPartial(chunks);
  }

  continueToolCallPartial(chunks: string[]): void {
    if (this._partialToolItemId === undefined) {
      throw new Error(
        "continueToolCallPartial called before streamToolCallPartial",
      );
    }
    if (this._partialToolIndex === undefined) {
      throw new Error(
        "continueToolCallPartial called before streamToolCallPartial",
      );
    }
    for (const chunk of chunks) {
      this.pushEvent({
        type: "response.function_call_arguments.delta",
        output_index: this._partialToolIndex,
        item_id: this._partialToolItemId,
        delta: chunk,
      });
    }
  }

  /** A reasoning item with one or more summary parts. Summary parts are
   * indexed by `summary_index`, independent of `output_index`. */
  streamReasoningSummary(
    parts: string[],
    options: { itemId?: string; encryptedContent?: string } = {},
  ): number {
    const itemId = options.itemId ?? `rs_mock_${this.outputIndex}`;
    const item: ResponseOutputItem = {
      type: "reasoning",
      id: itemId,
      summary: parts.map((text) => ({ type: "summary_text", text })),
      encrypted_content: options.encryptedContent ?? null,
    } as ResponseOutputItem;

    return this.emitItem(item, (outputIndex) => {
      parts.forEach((text, summaryIndex) => {
        this.pushEvent({
          type: "response.reasoning_summary_part.added",
          output_index: outputIndex,
          item_id: itemId,
          summary_index: summaryIndex,
          part: { type: "summary_text", text: "" },
        });
        this.pushEvent({
          type: "response.reasoning_summary_text.delta",
          output_index: outputIndex,
          item_id: itemId,
          summary_index: summaryIndex,
          delta: text,
        });
        this.pushEvent({
          type: "response.reasoning_summary_text.done",
          output_index: outputIndex,
          item_id: itemId,
          summary_index: summaryIndex,
          text,
        });
        this.pushEvent({
          type: "response.reasoning_summary_part.done",
          output_index: outputIndex,
          item_id: itemId,
          summary_index: summaryIndex,
          part: { type: "summary_text", text },
        });
      });
    });
  }

  /** A reasoning item that completes with no summary at all but does carry
   * encrypted_content — observed at low reasoning effort. */
  streamEmptyReasoning(encryptedContent: string, itemId?: string): number {
    return this.streamReasoningSummary([], {
      ...(itemId ? { itemId } : {}),
      encryptedContent,
    });
  }

  streamWebSearchCall(
    query: string,
    options: { itemId?: string } = {},
  ): number {
    const itemId = options.itemId ?? `ws_mock_${this.outputIndex}`;
    const outputIndex = this.outputIndex++;

    // The query is only present on the completed item, never on `added`.
    this.pushEvent({
      type: "response.output_item.added",
      output_index: outputIndex,
      item: { type: "web_search_call", id: itemId, status: "in_progress" },
    });
    const searchProgress = [
      "response.web_search_call.in_progress",
      "response.web_search_call.searching",
      "response.web_search_call.completed",
    ] as const;
    for (const type of searchProgress) {
      this.pushEvent({
        type,
        output_index: outputIndex,
        item_id: itemId,
      });
    }
    // The installed SDK omits `action` from ResponseFunctionWebSearch even
    // though the API sends it; see `webSearchQuery` in openai.ts.
    const item: ResponseOutputItem = {
      type: "web_search_call",
      id: itemId,
      status: "completed",
      action: { type: "search", query },
    } as ResponseOutputItem & { action: { type: "search"; query: string } };
    this.pushEvent({
      type: "response.output_item.done",
      output_index: outputIndex,
      item,
    });
    this.outputItems.push(item);
    return outputIndex;
  }

  finishResponse(
    _stopReason: StopReason = "end_turn",
    usage: Usage = { inputTokens: 1000, outputTokens: 500 },
  ): void {
    this._resolved = true;
    this.pushEvent({
      type: "response.completed",
      response: mockResponse(this.outputItems, usage),
    });
    this.close();
  }

  respondWithError(error: Error): void {
    this._resolved = true;
    try {
      this.readableController.error(error);
      this._closed = true;
    } catch {
      this.abort();
    }
  }

  /** A client-side abort: the stream just stops. No terminal event, no usage. */
  abortMidstream(): void {
    this._resolved = true;
    this.close();
  }

  /** The completed items the mock has emitted so far, in the shape the
   * backend would echo them in `response.completed`. */
  getOutputItems(): ResponseOutputItem[] {
    return this.outputItems;
  }
}

/** Every function_call echoed in `input` must be answered by a
 * function_call_output with the same call_id — the Responses analogue of
 * Anthropic's tool_use/tool_result pairing. */
function validateToolCallPairing(input: OpenAI.Responses.ResponseInput): void {
  const outputs = new Set(
    input
      .filter((item) => item.type === "function_call_output")
      .map((item) => item.call_id),
  );
  for (const item of input) {
    if (item.type === "function_call" && !outputs.has(item.call_id)) {
      throw new Error(
        `MockOpenAIClient: missing function_call_output for call_id "${item.call_id}".`,
      );
    }
  }
}

/** A minimal completed non-streaming Response, for the `forceToolUse` path. */
export function mockResponse(
  output: ResponseOutputItem[],
  usage: Usage = { inputTokens: 100, outputTokens: 10 },
): OpenAI.Responses.Response {
  return {
    id: "resp_mock",
    object: "response",
    created_at: 0,
    model: "mock-model",
    status: "completed",
    error: null,
    incomplete_details: null,
    instructions: null,
    metadata: null,
    output,
    parallel_tool_calls: true,
    temperature: null,
    tool_choice: "auto",
    tools: [],
    top_p: null,
    output_text: "",
    usage: {
      input_tokens: usage.inputTokens,
      input_tokens_details: { cached_tokens: usage.cacheHits ?? 0 },
      output_tokens: usage.outputTokens,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: usage.inputTokens + usage.outputTokens,
    },
  };
}

/** Mirrors the SDK's overloaded `responses.create`: streaming params yield a
 * stream, non-streaming params a completed Response. */
class MockResponses {
  constructor(private client: MockOpenAIClient) {}

  create(
    params: OpenAI.Responses.ResponseCreateParamsStreaming,
  ): Promise<MockResponseStream>;
  create(
    params: OpenAI.Responses.ResponseCreateParamsNonStreaming,
  ): Promise<OpenAI.Responses.Response>;
  create(
    params: OpenAI.Responses.ResponseCreateParams,
  ): Promise<MockResponseStream | OpenAI.Responses.Response> {
    validateToolCallPairing((params.input ?? []) as ResponseInputItem[]);
    if (params.stream !== true) {
      this.client.nonStreamingRequests.push(params);
      const next = this.client.nonStreamingQueue.shift();
      if (!next) {
        return Promise.reject(
          new Error("MockOpenAIClient: nonStreamingQueue is empty"),
        );
      }
      return next instanceof Error
        ? Promise.reject(next)
        : Promise.resolve(next);
    }
    const stream = new MockResponseStream(params);
    this.client.streams.push(stream);
    return Promise.resolve(stream);
  }
}

export class MockOpenAIClient {
  public streams: MockResponseStream[] = [];
  /** Requests made against the non-streaming endpoint (`forceToolUse`). */
  public nonStreamingRequests: OpenAI.Responses.ResponseCreateParamsNonStreaming[] =
    [];
  /** Consumed in order by non-streaming `create` calls; an Error is thrown. */
  public nonStreamingQueue: (OpenAI.Responses.Response | Error)[] = [];

  responses = new MockResponses(this);

  get lastStream(): MockResponseStream | undefined {
    return this.streams[this.streams.length - 1];
  }

  async awaitStream(): Promise<MockResponseStream> {
    return pollUntil(() => {
      const stream = this.lastStream;
      if (stream && !stream.aborted) {
        return stream;
      }
      throw new Error("No pending stream");
    });
  }
}
