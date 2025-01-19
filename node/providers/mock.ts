import { type ToolRequest } from "../tools/toolManager.ts";
import { type Result } from "../utils/result.ts";
import { Defer, pollUntil } from "../utils/async.ts";
import {
  setClient,
  type Provider,
  type ProviderMessage,
  type StopReason,
  type Usage,
} from "./provider.ts";
import type { InlineEditToolRequest } from "../tools/inlineEdit.ts";

type MockRequest = {
  messages: Array<ProviderMessage>;
  onText: (text: string) => void;
  onError: (error: Error) => void;
  defer: Defer<{
    toolRequests: Result<ToolRequest, { rawRequest: unknown }>[];
    stopReason: StopReason;
    usage: Usage;
  }>;
};

type MockInlineRequest = {
  messages: Array<ProviderMessage>;
  defer: Defer<{
    inlineEdit: Result<InlineEditToolRequest, { rawRequest: unknown }>;
    stopReason: StopReason;
    usage: Usage;
  }>;
};

export class MockProvider implements Provider {
  public requests: MockRequest[] = [];
  public inlineRequests: MockInlineRequest[] = [];

  abort() {
    if (this.requests.length) {
      const lastRequest = this.requests[this.requests.length - 1];
      if (!lastRequest.defer.resolved) {
        lastRequest.defer.resolve({
          toolRequests: [],
          stopReason: "end_turn",
          usage: {
            inputTokens: 0,
            outputTokens: 0,
          },
        });
      }
    }
  }

  createStreamParameters(messages: Array<ProviderMessage>): unknown {
    return messages;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async countTokens(messages: Array<ProviderMessage>): Promise<number> {
    return messages.length;
  }

  async inlineEdit(messages: Array<ProviderMessage>): Promise<{
    inlineEdit: Result<InlineEditToolRequest, { rawRequest: unknown }>;
    stopReason: StopReason;
    usage: Usage;
  }> {
    const request: MockInlineRequest = {
      messages,
      defer: new Defer(),
    };
    this.inlineRequests.push(request);
    return request.defer.promise;
  }

  async sendMessage(
    messages: Array<ProviderMessage>,
    onText: (text: string) => void,
    onError: (error: Error) => void,
  ): Promise<{
    toolRequests: Result<ToolRequest, { rawRequest: unknown }>[];
    stopReason: StopReason;
    usage: Usage;
  }> {
    const request: MockRequest = {
      messages,
      onText,
      onError,
      defer: new Defer(),
    };
    this.requests.push(request);
    return request.defer.promise;
  }

  async awaitPendingRequest() {
    return pollUntil(() => {
      const lastRequest = this.requests[this.requests.length - 1];
      if (lastRequest && !lastRequest.defer.resolved) {
        return lastRequest;
      }
      throw new Error(`no pending requests`);
    });
  }

  async respond({
    text,
    toolRequests,
    stopReason,
  }: {
    text?: string;
    toolRequests: Result<ToolRequest, { rawRequest: unknown }>[];
    stopReason: StopReason;
  }) {
    const lastRequest = await this.awaitPendingRequest();

    if (text) {
      lastRequest.onText(text);
    }

    lastRequest.defer.resolve({
      toolRequests,
      stopReason,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
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
