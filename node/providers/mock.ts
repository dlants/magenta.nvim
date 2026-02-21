import { type Result } from "../utils/result.ts";
import { Defer, pollUntil } from "../utils/async.ts";
import type {
  Provider,
  ProviderMessage,
  ProviderStreamRequest,
  StopReason,
  Usage,
  ProviderToolSpec,
  ProviderToolUseRequest,
  ProviderStreamEvent,
  Agent,
  AgentOptions,
  AgentInput,
  AgentMsg,
} from "./provider-types.ts";
import type { Dispatch } from "../tea/tea.ts";
import { setMockProvider } from "./provider.ts";
import { DEFAULT_SYSTEM_PROMPT } from "./system-prompt.ts";
import type { ToolRequest } from "../tools/types.ts";
import { AnthropicAgent } from "./anthropic-agent.ts";
import { MockAnthropicClient, MockStream } from "./mock-anthropic-client.ts";
import type Anthropic from "@anthropic-ai/sdk";
import winston from "winston";

function anthropicBlockIncludesText(
  block: Anthropic.Messages.ContentBlockParam,
  text: string,
): boolean {
  switch (block.type) {
    case "text":
      return block.text.includes(text);
    case "tool_use":
      return JSON.stringify(block.input).includes(text);
    case "tool_result":
      if (typeof block.content === "string") {
        return block.content.includes(text);
      }
      if (Array.isArray(block.content)) {
        return block.content.some(
          (c) => c.type === "text" && c.text.includes(text),
        );
      }
      return false;
    case "thinking":
      return block.thinking.includes(text);
    default:
      return false;
  }
}

type MockForceToolUseRequest = {
  model: string;
  input: AgentInput[];
  spec: ProviderToolSpec;
  systemPrompt?: string | undefined;
  contextAgent?: Agent | undefined;
  defer: Defer<{
    toolRequest: Result<ToolRequest, { rawRequest: unknown }>;
    stopReason: StopReason;
    usage: Usage;
  }>;
  aborted: boolean;
};

export class MockProvider implements Provider {
  public forceToolUseRequests: MockForceToolUseRequest[] = [];
  public mockClient = new MockAnthropicClient();
  private blockCounter = 0;

  getNextBlockId(): string {
    return `block_${this.blockCounter++}`;
  }

  setModel(_model: string): void {}

  createStreamParameters(options: {
    model: string;
    messages: Array<ProviderMessage>;
    tools: Array<ProviderToolSpec>;
    disableCaching?: boolean;
    systemPrompt?: string | undefined;
  }): unknown {
    return { messages: options.messages, tools: options.tools };
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

  forceToolUse(options: {
    model: string;
    input: AgentInput[];
    spec: ProviderToolSpec;
    systemPrompt?: string;
    disableCaching?: boolean;
    contextAgent?: Agent;
  }): ProviderToolUseRequest {
    const { model, input, spec, systemPrompt, contextAgent } = options;
    const request: MockForceToolUseRequest = {
      model,
      input,
      spec,
      systemPrompt,
      contextAgent,
      defer: new Defer(),
      aborted: false,
    };
    this.forceToolUseRequests.push(request);

    return {
      abort: () => {
        if (!request.defer.resolved) {
          request.aborted = true;
          request.defer.reject(new Error("request aborted"));
        }
      },
      aborted: request.aborted,
      promise: request.defer.promise,
    };
  }

  sendMessage(_options: {
    model: string;
    messages: Array<ProviderMessage>;
    onStreamEvent: (event: ProviderStreamEvent) => void;
    tools: Array<ProviderToolSpec>;
    systemPrompt?: string | undefined;
    thinking?: {
      enabled: boolean;
      budgetTokens?: number;
    };
  }): ProviderStreamRequest {
    throw new Error(
      "sendMessage is deprecated - use createAgent instead. Tests should use mockAnthropic.awaitPendingStream()",
    );
  }

  async awaitPendingStream(options?: {
    predicate?: (request: MockStream) => boolean;
    message?: string;
  }): Promise<MockStream> {
    return pollUntil(() => {
      // Check mock client streams first (new API) - find the latest unresolved stream
      for (let i = this.mockClient.streams.length - 1; i >= 0; i--) {
        const stream = this.mockClient.streams[i];
        if (stream && !stream.aborted && !stream.resolved) {
          if (!options?.predicate || options.predicate(stream)) {
            return stream;
          }
        }
      }
      // Fall back to legacy requests
      throw new Error(`No pending streams${options?.predicate ? " matching predicate" : ""}! ${options?.message ?? ""}
Streams: ${this.mockClient.streams.length}`);
    });
  }

  async awaitPendingStreamWithText(
    text: string,
    message?: string,
  ): Promise<MockStream> {
    return this.awaitPendingStream({
      predicate: (stream) => {
        // Check all recent user messages (last 3) since system reminders may follow tool results
        const messagesToCheck = Math.min(3, stream.messages.length);
        for (
          let i = stream.messages.length - 1;
          i >= stream.messages.length - messagesToCheck;
          i--
        ) {
          const msg = stream.messages[i];
          if (msg.role !== "user") continue;

          const content = msg.content;
          if (typeof content === "string") {
            if (content.includes(text)) return true;
          } else {
            for (const block of content) {
              if (anthropicBlockIncludesText(block, text)) {
                return true;
              }
            }
          }
        }
        return false;
      },
      message: message ?? `recent messages contain "${text}"`,
    });
  }

  async awaitPendingUserRequest(message?: string) {
    return this.awaitPendingStream({
      predicate: (request) => {
        return request.messages[request.messages.length - 1].role === "user";
      },
      message: message ?? "there is a pending request with a user message",
    });
  }

  /**
   * Find the last user message containing a tool_result in the stream's messages.
   * Returns the message and its content array.
   */
  static findLastToolResultMessage(
    messages: Anthropic.Messages.MessageParam[],
  ): Anthropic.Messages.MessageParam | undefined {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === "user" && Array.isArray(msg.content)) {
        const hasToolResult = msg.content.some(
          (block) => block.type === "tool_result",
        );
        if (hasToolResult) {
          return msg;
        }
      }
    }
    return undefined;
  }

  async awaitStopped(): Promise<MockStream> {
    return pollUntil(() => {
      const lastStream =
        this.mockClient.streams[this.mockClient.streams.length - 1];
      if (lastStream && lastStream.resolved) {
        return lastStream;
      }
      throw new Error(`has pending streams`);
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

  hasPendingStreamWithText(text: string): boolean {
    for (const stream of this.mockClient.streams) {
      if (stream && !stream.resolved) {
        // Check all recent user messages (last 3) since system reminders may follow tool results
        const messagesToCheck = Math.min(3, stream.messages.length);
        for (
          let i = stream.messages.length - 1;
          i >= stream.messages.length - messagesToCheck;
          i--
        ) {
          const msg = stream.messages[i];
          if (msg.role !== "user") continue;

          const content = msg.content;
          if (typeof content === "string") {
            if (content.includes(text)) {
              return true;
            }
          } else {
            for (const block of content) {
              if (anthropicBlockIncludesText(block, text)) {
                return true;
              }
            }
          }
        }
      }
    }
    return false;
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

  createAgent(options: AgentOptions, dispatch: Dispatch<AgentMsg>): Agent {
    return new AnthropicAgent(
      options,
      this.mockClient as unknown as Anthropic,
      dispatch,
      {
        authType: "max",
        includeWebSearch: true,
        disableParallelToolUseFlag: true,
        logger: winston.createLogger(),
      },
    );
  }
}

export async function withMockClient(
  fn: (mock: MockProvider) => Promise<void>,
) {
  const mock = new MockProvider();
  // these should match the defaults in the
  setMockProvider(mock);
  try {
    await fn(mock);
  } finally {
    setMockProvider(undefined);
  }
}
