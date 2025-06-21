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
  type ProviderMessageContent,
} from "./provider-types.ts";
import { setClient } from "./provider.ts";
import { DEFAULT_SYSTEM_PROMPT } from "./system-prompt.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import type { ToolRequest } from "../tools/types.ts";

class MockRequest {
  defer: Defer<{
    stopReason: StopReason;
    usage: Usage;
  }>;

  constructor(
    public messages: Array<ProviderMessage>,
    public onStreamEvent: (event: ProviderStreamEvent) => void,
    private getNextBlockId: () => string,
  ) {
    this.defer = new Defer();
  }

  streamText(text: string): void {
    // Send content_block_start event
    this.onStreamEvent({
      type: "content_block_start",
      index: 0,
      content_block: {
        type: "text",
        text: "",
        citations: null,
      },
    });

    // Send text delta
    this.onStreamEvent({
      type: "content_block_delta",
      index: 0,
      delta: {
        type: "text_delta",
        text,
      },
    });

    // Send content_block_stop event
    this.onStreamEvent({
      type: "content_block_stop",
      index: 0,
    });
  }
  streamToolUse(
    toolRequest: Result<ToolRequest, { rawRequest: unknown }>,
  ): void {
    const blockId = this.getNextBlockId();
    const index = 0;

    this.onStreamEvent({
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

    this.onStreamEvent({
      type: "content_block_delta",
      index,
      delta: {
        type: "input_json_delta",
        partial_json: inputJson,
      },
    });

    this.onStreamEvent({
      type: "content_block_stop",
      index,
    });
  }

  respond({
    text,
    toolRequests,
    stopReason,
  }: {
    text: string;
    toolRequests: Result<ToolRequest, { rawRequest: unknown }>[];
    stopReason: StopReason;
  }): void {
    if (text) {
      this.streamText(text);
    }

    if (toolRequests && toolRequests.length > 0) {
      for (let i = 0; i < toolRequests.length; i++) {
        this.streamToolUse(toolRequests[i]);
      }
    }

    this.defer.resolve({
      stopReason,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
      },
    });
  }

  respondWithError(error: Error) {
    this.defer.reject(error);
  }

  abort() {
    if (!this.defer.resolved) {
      this.defer.reject(new Error("request aborted"));
    }
  }

  finishResponse(stopReason: StopReason) {
    this.defer.resolve({
      stopReason,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
      },
    });
  }
}

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
    const request = new MockRequest(
      messages,
      onStreamEvent,
      this.getNextBlockId.bind(this),
    );

    this.requests.push(request);
    return {
      promise: request.defer.promise,
      abort: request.abort.bind(request),
    };
  }

  async awaitPendingRequest(options?: {
    predicate?: (request: MockRequest) => boolean;
    message?: string;
  }) {
    return pollUntil(() => {
      for (const request of [...this.requests].reverse())
        if (
          request &&
          !request.defer.resolved &&
          (!options?.predicate || options.predicate(request))
        ) {
          return request;
        }
      throw new Error(`No pending requests! ${options?.message ?? ""}
Requests and their last messages:
${this.requests.map((r) => `${r.defer.resolved ? "resolved" : "pending"} - ${JSON.stringify(r.messages[r.messages.length - 1])}`).join("\n")} `);
    });
  }

  async awaitPendingRequestWithText(text: string, message?: string) {
    function blockIncludesText(block: ProviderMessageContent) {
      switch (block.type) {
        case "text":
          if (block.text.includes(text)) {
            return true;
          } else {
            return false;
          }
        case "tool_use":
          if (
            block.request.status == "ok" &&
            JSON.stringify(block.request.value).includes(text)
          ) {
            return true;
          }
          return false;
        case "server_tool_use":
          return false;
        case "web_search_tool_result":
          if (Array.isArray(block.content)) {
            for (const result of block.content) {
              if (result.title.includes(text) || result.url.includes(text)) {
                return true;
              }
            }
          }
          return false;
        case "tool_result":
          if (block.result.status == "ok") {
            const value = block.result.value;
            if (Array.isArray(value)) {
              for (const item of value) {
                if (
                  item &&
                  typeof item === "object" &&
                  item.type === "text" &&
                  item.text.includes(text)
                ) {
                  return true;
                }
              }
            }
          } else if (block.result.status == "error") {
            if (block.result.error.includes(text)) {
              return true;
            }
          }
          return false;

        case "image":
          return block.source.media_type.includes(text);

        case "document":
          return (
            block.source.media_type.includes(text) ||
            (block.title && block.title.includes(text))
          );

        default:
          assertUnreachable(block);
      }
    }

    return this.awaitPendingRequest({
      predicate: (request) => {
        const lastMessage = request.messages[request.messages.length - 1];
        for (const block of lastMessage.content) {
          if (blockIncludesText(block)) {
            return true;
          }
        }
        return false;
      },
      message: message ?? `last message contains "${text}"`,
    });
  }

  async awaitPendingUserRequest(message?: string) {
    return this.awaitPendingRequest({
      predicate: (request) => {
        return request.messages[request.messages.length - 1].role === "user";
      },
      message: message ?? "there is a pending request with a user message",
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

  /**
   * Completes a request with the given stop reason and usage statistics
   */
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
