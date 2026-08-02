import type OpenAI from "openai";
import { Stream } from "openai/core/streaming.mjs";
import { pollUntil } from "../utils/async.ts";
import type { StopReason, Usage } from "./provider-types.ts";

type ResponseStreamEvent = OpenAI.Responses.ResponseStreamEvent;
type ResponseOutputItem = OpenAI.Responses.ResponseOutputItem;

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

  get instructions(): string | null | undefined {
    return this.params.instructions;
  }

  /** Items of the request's `input` with the given `type`, for assertions on
   * what the provider echoed back. */
  inputItemsOfType(type: string): Record<string, unknown>[] {
    return (this.input as unknown as Record<string, unknown>[]).filter(
      (item) => item.type === type,
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

  private pushEvent(event: Partial<ResponseStreamEvent>): void {
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

  emitEvent(event: Partial<ResponseStreamEvent>): void {
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
    } as Partial<ResponseStreamEvent>);
    body(outputIndex);
    this.pushEvent({
      type: "response.output_item.done",
      output_index: outputIndex,
      item,
    } as Partial<ResponseStreamEvent>);
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
      } as Partial<ResponseStreamEvent>);
      this.pushEvent({
        type: "response.output_text.delta",
        output_index: outputIndex,
        item_id: itemId,
        content_index: 0,
        delta: text,
      } as Partial<ResponseStreamEvent>);
      for (const annotation of annotations) {
        this.pushEvent({
          type: "response.output_text.annotation.added",
          output_index: outputIndex,
          item_id: itemId,
          content_index: 0,
          annotation_index: 0,
          annotation,
        } as Partial<ResponseStreamEvent>);
      }
      this.pushEvent({
        type: "response.output_text.done",
        output_index: outputIndex,
        item_id: itemId,
        content_index: 0,
        text,
      } as Partial<ResponseStreamEvent>);
      this.pushEvent({
        type: "response.content_part.done",
        output_index: outputIndex,
        item_id: itemId,
        content_index: 0,
        part: { type: "output_text", text, annotations },
      } as Partial<ResponseStreamEvent>);
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
      } as Partial<ResponseStreamEvent>);
      this.pushEvent({
        type: "response.function_call_arguments.done",
        output_index: outputIndex,
        item_id: itemId,
        arguments: args,
      } as Partial<ResponseStreamEvent>);
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
    } as Partial<ResponseStreamEvent>);
    this.continueToolCallPartial(chunks);
  }

  continueToolCallPartial(chunks: string[]): void {
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
      } as Partial<ResponseStreamEvent>);
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
        } as Partial<ResponseStreamEvent>);
        this.pushEvent({
          type: "response.reasoning_summary_text.delta",
          output_index: outputIndex,
          item_id: itemId,
          summary_index: summaryIndex,
          delta: text,
        } as Partial<ResponseStreamEvent>);
        this.pushEvent({
          type: "response.reasoning_summary_text.done",
          output_index: outputIndex,
          item_id: itemId,
          summary_index: summaryIndex,
          text,
        } as Partial<ResponseStreamEvent>);
        this.pushEvent({
          type: "response.reasoning_summary_part.done",
          output_index: outputIndex,
          item_id: itemId,
          summary_index: summaryIndex,
          part: { type: "summary_text", text },
        } as Partial<ResponseStreamEvent>);
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
    } as Partial<ResponseStreamEvent>);
    for (const type of [
      "response.web_search_call.in_progress",
      "response.web_search_call.searching",
      "response.web_search_call.completed",
    ]) {
      this.pushEvent({
        type,
        output_index: outputIndex,
        item_id: itemId,
      } as Partial<ResponseStreamEvent>);
    }
    const item = {
      type: "web_search_call",
      id: itemId,
      status: "completed",
      action: { type: "search", query, queries: [query] },
    } as unknown as ResponseOutputItem;
    this.pushEvent({
      type: "response.output_item.done",
      output_index: outputIndex,
      item,
    } as Partial<ResponseStreamEvent>);
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
      response: {
        id: "resp_mock",
        object: "response",
        status: "completed",
        output: this.outputItems,
        usage: {
          input_tokens: usage.inputTokens,
          input_tokens_details: { cached_tokens: usage.cacheHits ?? 0 },
          output_tokens: usage.outputTokens,
          output_tokens_details: { reasoning_tokens: 0 },
          total_tokens: usage.inputTokens + usage.outputTokens,
        },
      },
    } as Partial<ResponseStreamEvent>);
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
  const items = input as unknown as {
    type?: string;
    call_id?: string;
  }[];
  const outputs = new Set(
    items
      .filter((item) => item.type === "function_call_output")
      .map((item) => item.call_id),
  );
  for (const item of items) {
    if (item.type === "function_call" && !outputs.has(item.call_id)) {
      throw new Error(
        `MockOpenAIClient: missing function_call_output for call_id "${item.call_id}".`,
      );
    }
  }
}

export class MockOpenAIClient {
  public streams: MockResponseStream[] = [];

  responses = {
    create: (
      params: OpenAI.Responses.ResponseCreateParamsStreaming,
    ): Promise<MockResponseStream> => {
      validateToolCallPairing(params.input as OpenAI.Responses.ResponseInput);
      const stream = new MockResponseStream(params);
      this.streams.push(stream);
      return Promise.resolve(stream);
    },
  };

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
