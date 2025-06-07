import { type ToolRequest } from "../tools/toolManager.ts";
import { type Result } from "../utils/result.ts";
import { Defer, pollUntil } from "../utils/async.ts";
import {
  type Provider,
  type ProviderMessage,
  type ProviderStreamRequest,
  type StopReason,
  type Usage,
  type ProviderToolSpec,
  type ProviderToolUseRequest,
  type ProviderStreamEvent,
} from "./provider-types.ts";
import { setClient } from "./provider.ts";
import { DEFAULT_SYSTEM_PROMPT } from "./system-prompt.ts";

type MockRequest = {
  messages: Array<ProviderMessage>;
  onStreamEvent: (event: ProviderStreamEvent) => void;
  defer: Defer<{
    stopReason: StopReason;
    usage: Usage;
  }>;
};

type MockForceToolUseRequest = {
  messages: Array<ProviderMessage>;
  spec: ProviderToolSpec;
  defer: Defer<{
    toolRequest: Result<ToolRequest, { rawRequest: unknown }>;
    stopReason: StopReason;
    usage: Usage;
  }>;
};

export class MockProvider implements Provider {
  public requests: MockRequest[] = [];
  public forceToolUseRequests: MockForceToolUseRequest[] = [];
  private blockCounter = 0;

  setModel(_model: string): void {}

  createStreamParameters(
    messages: Array<ProviderMessage>,
    tools: Array<ProviderToolSpec>,
    _options?: { disableCaching?: boolean },
  ): unknown {
    return { messages, tools };
  }

  countTokens(
    messages: Array<ProviderMessage>,
    tools: Array<ProviderToolSpec>,
  ): number {
    const CHARS_PER_TOKEN = 4;

    let charCount = DEFAULT_SYSTEM_PROMPT.length;
    charCount += JSON.stringify(tools).length;
    charCount += JSON.stringify(messages).length;

    return Math.ceil(charCount / CHARS_PER_TOKEN);
  }

  forceToolUse(
    messages: Array<ProviderMessage>,
    spec: ProviderToolSpec,
  ): ProviderToolUseRequest {
    const request: MockForceToolUseRequest = {
      messages,
      spec,
      defer: new Defer(),
    };
    this.forceToolUseRequests.push(request);

    return {
      abort: () => {
        if (!request.defer.resolved) {
          request.defer.reject(new Error("request aborted"));
        }
      },
      promise: request.defer.promise,
    };
  }

  sendMessage(
    messages: Array<ProviderMessage>,
    onStreamEvent: (event: ProviderStreamEvent) => void,
    _tools: Array<ProviderToolSpec>,
  ): ProviderStreamRequest {
    const request: MockRequest = {
      messages,
      onStreamEvent,
      defer: new Defer(),
    };
    this.requests.push(request);
    return {
      abort: () => {
        if (!request.defer.resolved) {
          request.defer.reject(new Error("request aborted"));
        }
      },

      promise: request.defer.promise,
    };
  }

  async awaitPendingRequest(message?: string) {
    return pollUntil(() => {
      const lastRequest = this.requests[this.requests.length - 1];
      if (lastRequest && !lastRequest.defer.resolved) {
        return lastRequest;
      }
      throw new Error(`no pending requests: ${message}`);
    });
  }

  async awaitPendingUserRequest() {
    return pollUntil(() => {
      const lastRequest = this.requests[this.requests.length - 1];
      if (
        lastRequest &&
        !lastRequest.defer.resolved &&
        lastRequest.messages[lastRequest.messages.length - 1].role == "user"
      ) {
        return lastRequest;
      }
      throw new Error(`no pending requests`);
    });
  }

  async awaitStopped() {
    return pollUntil(() => {
      const lastRequest = this.requests[this.requests.length - 1];
      if (lastRequest && lastRequest.defer.resolved) {
        return lastRequest;
      }
      throw new Error(`has pending requests`);
    });
  }

  async awaitPendingForceToolUseRequest(message?: string) {
    return pollUntil(() => {
      const lastRequest =
        this.forceToolUseRequests[this.forceToolUseRequests.length - 1];
      if (lastRequest && !lastRequest.defer.resolved) {
        return lastRequest;
      }
      throw new Error(`no pending force tool use requests: ${message}`);
    });
  }

  private getNextBlockId(): string {
    return `block_${this.blockCounter++}`;
  }

  /**
   * Helper to stream text content without resolving the request
   */
  async streamText(text: string) {
    const lastRequest = await this.awaitPendingRequest();
    const index = 0;

    // Send content_block_start event
    lastRequest.onStreamEvent({
      type: "content_block_start",
      index,
      content_block: {
        type: "text",
        text: "",
        citations: null,
      },
    });

    // Send text delta
    lastRequest.onStreamEvent({
      type: "content_block_delta",
      index,
      delta: {
        type: "text_delta",
        text,
      },
    });

    // Send content_block_stop event
    lastRequest.onStreamEvent({
      type: "content_block_stop",
      index,
    });
  }

  /**
   * Helper to stream tool use content without resolving the request
   */
  async streamToolUse(
    toolRequest: Result<ToolRequest, { rawRequest: unknown }>,
  ) {
    const lastRequest = await this.awaitPendingRequest();
    const blockId = this.getNextBlockId();
    const index = 0;

    // Send content_block_start event for tool_use
    lastRequest.onStreamEvent({
      type: "content_block_start",
      index,
      content_block: {
        type: "tool_use",
        id: toolRequest.status === "ok" ? toolRequest.value.id : blockId,
        name:
          toolRequest.status === "ok" ? toolRequest.value.toolName : "unknown",
        input: {},
      },
    });

    // Send tool input as JSON delta
    const inputJson = JSON.stringify(
      toolRequest.status === "ok"
        ? toolRequest.value.input
        : toolRequest.rawRequest,
    );

    lastRequest.onStreamEvent({
      type: "content_block_delta",
      index,
      delta: {
        type: "input_json_delta",
        partial_json: inputJson,
      },
    });

    lastRequest.onStreamEvent({
      type: "content_block_stop",
      index,
    });
  }

  async streamEvents(events: ProviderStreamEvent[]) {
    const lastRequest = await this.awaitPendingRequest();
    for (const event of events) {
      lastRequest.onStreamEvent(event);
    }
  }

  /**
   * Legacy method for backwards compatibility
   * @deprecated Use streamText() + finishResponse() instead
   */
  async respondWithText(text: string, stopReason: StopReason = "end_turn") {
    await this.streamText(text);
    await this.finishResponse(stopReason);
  }

  /**
   * Legacy method for backwards compatibility
   * @deprecated Use streamToolUse() + finishResponse() instead
   */
  async respondWithToolUse(
    toolRequest: Result<ToolRequest, { rawRequest: unknown }>,
    stopReason: StopReason = "tool_use",
  ) {
    await this.streamToolUse(toolRequest);
    await this.finishResponse(stopReason);
  }

  /**
   * Helper to generate a web search tool use response
   */
  // async respondWithWebSearch(
  //   query: string,
  //   stopReason: StopReason = "tool_use",
  // ) {
  //   const lastRequest = await this.awaitPendingRequest();
  //   const blockId = this.getNextBlockId();
  //   const index = 0;
  //
  //   // Send content_block_start event for server_tool_use
  //   lastRequest.onStreamEvent({
  //     type: "content_block_start",
  //     index,
  //     content_block: {
  //       type: "server_tool_use",
  //       id: blockId,
  //       name: "web_search",
  //     },
  //   });
  //
  //   // Send search query as JSON delta
  //   lastRequest.onStreamEvent({
  //     type: "content_block_delta",
  //     index,
  //     delta: {
  //       type: "input_json_delta",
  //       value: JSON.stringify({ query }),
  //     },
  //   });
  //
  //   // Send content_block_stop event
  //   lastRequest.onStreamEvent({
  //     type: "content_block_stop",
  //     index,
  //   });
  //
  //   // Resolve the request
  //   lastRequest.defer.resolve({
  //     stopReason,
  //     usage: {
  //       inputTokens: 10,
  //       outputTokens: 20,
  //     },
  //   });
  // }

  async respond({
    text,
    toolRequests,
    stopReason,
  }: {
    text?: string;
    toolRequests?: Result<ToolRequest, { rawRequest: unknown }>[];
    stopReason: StopReason;
  }) {
    if (text) {
      await this.streamText(text);
    }

    if (toolRequests && toolRequests.length > 0) {
      for (let i = 0; i < toolRequests.length; i++) {
        await this.streamToolUse(toolRequests[i]);
      }
    }

    // Finish the response with the given stop reason
    await this.finishResponse(stopReason);
  }

  async respondWithError(error: Error) {
    const lastRequest = await this.awaitPendingRequest();
    lastRequest.defer.reject(error);
  }
  /**
   * Completes a request with the given stop reason and usage statistics
   */
  async finishResponse(stopReason: StopReason) {
    const lastRequest = await this.awaitPendingRequest();
    lastRequest.defer.resolve({
      stopReason,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
      },
    });
  }

  async respondToForceToolUse({
    toolRequest,
    stopReason,
  }: {
    toolRequest: Result<ToolRequest, { rawRequest: unknown }>;
    stopReason: StopReason;
  }) {
    const lastRequest = await this.awaitPendingForceToolUseRequest();

    lastRequest.defer.resolve({
      toolRequest,
      stopReason,
      usage: {
        inputTokens: 10,
        outputTokens: 20,
      },
    });
  }
}

export async function withMockClient(
  fn: (mock: MockProvider) => Promise<void>,
) {
  const mock = new MockProvider();
  setClient("anthropic", mock);
  try {
    await fn(mock);
  } finally {
    setClient("anthropic", undefined);
  }
}
