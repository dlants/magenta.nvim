import { APIError } from "openai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolName, ToolRequestId } from "../tool-types.ts";
import { validateInput } from "../tools/helpers.ts";
import { MockOpenAIClient } from "./mock-openai-client.ts";
import { OpenAIAgent, type OpenAIStreamingClient } from "./openai-agent.ts";
import {
  PLACEHOLDER_NATIVE_MESSAGE_IDX,
  type ProviderToolSpec,
} from "./provider-types.ts";

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

const spec: ProviderToolSpec = {
  name: "get_files" as ToolName,
  description: "gets files",
  input_schema: {
    type: "object",
    properties: { filePath: { type: "string" } },
  } as ProviderToolSpec["input_schema"],
};

function setup() {
  const client = new MockOpenAIClient();
  const agent = new OpenAIAgent(
    { model: "gpt-5.4", systemPrompt: "be helpful", tools: [spec] },
    client as unknown as OpenAIStreamingClient,
    { includeWebSearch: false, logger: noopLogger, validateInput },
  );
  const events = {
    stopped: [] as { stopReason: string }[],
    errors: [] as Error[],
  };
  agent.on("stopped", (stopReason) => events.stopped.push({ stopReason }));
  agent.on("error", (error) => events.errors.push(error));
  return { client, agent, events };
}

function apiError(status: number): APIError {
  return new APIError(
    status,
    { message: `status ${status}` },
    "err",
    new Headers(),
  );
}

/** Let the SDK's stream reader drain and the agent's microtasks settle. */
async function tick(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) {
    await vi.advanceTimersByTimeAsync(0);
  }
}

describe("OpenAIAgent retry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function start(client: MockOpenAIClient, agent: OpenAIAgent) {
    agent.appendUserMessage([
      {
        type: "text",
        text: "hello",
        nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
      },
    ]);
    agent.continueConversation();
    return client.awaitStreamAt(0);
  }

  it("retries a retryable error and discards the partial attempt", async () => {
    const { client, agent, events } = setup();
    const stream = await start(client, agent);

    stream.streamText("half an answer");
    await tick();
    stream.respondWithError(apiError(429));
    await tick();

    const status = agent.getState().status;
    expect(status.type).toBe("streaming");
    if (status.type === "streaming") {
      expect(status.retryStatus?.attempt).toBe(1);
    }

    await vi.advanceTimersByTimeAsync(1000);
    const retry = await client.awaitStreamAt(1);
    retry.streamText("the real answer");
    await tick();
    retry.finishResponse();
    await tick();

    expect(events.errors).toHaveLength(0);
    expect(events.stopped.map((s) => s.stopReason)).toEqual(["end_turn"]);

    const messages = agent.getState().messages;
    const assistant = messages[messages.length - 1];
    // The half-accumulated text from the failed attempt must not survive.
    expect(assistant.content).toHaveLength(1);
    expect(assistant.content[0]).toMatchObject({
      type: "text",
      text: "the real answer",
    });
  });

  it("surfaces a non-retryable error without retrying", async () => {
    const { client, agent, events } = setup();
    const stream = await start(client, agent);
    stream.respondWithError(apiError(400));
    await tick();

    expect(events.errors).toHaveLength(1);
    expect(events.stopped).toHaveLength(0);
    expect(agent.getState().status.type).toBe("error");
    expect(client.streams).toHaveLength(1);
  });

  it("treats response.failed as an error", async () => {
    const { client, agent, events } = setup();
    const stream = await start(client, agent);
    stream.emitEvent({
      type: "response.failed",
      response: {
        ...mockFailedResponse(),
        error: { code: "server_error", message: "backend exploded" },
      },
    });
    await tick();

    expect(events.errors.map((e) => e.message)).toEqual(["backend exploded"]);
    expect(agent.getState().status.type).toBe("error");
  });

  it("falls back to a generic message when response.failed carries no error", async () => {
    const { client, agent, events } = setup();
    const stream = await start(client, agent);
    stream.emitEvent({
      type: "response.failed",
      response: mockFailedResponse(),
    });
    await tick();

    expect(events.errors.map((e) => e.message)).toEqual(["response.failed"]);
  });

  it("treats an `error` stream event as an error", async () => {
    const { client, agent, events } = setup();
    const stream = await start(client, agent);
    stream.emitEvent({
      type: "error",
      code: "rate_limit",
      message: "slow down",
      param: null,
    });
    await tick();

    expect(events.errors.map((e) => e.message)).toEqual(["slow down"]);
    expect(agent.getState().status.type).toBe("error");
  });

  it("aborting during the backoff sleep lands in the aborted state", async () => {
    const { client, agent, events } = setup();
    const stream = await start(client, agent);
    stream.respondWithError(apiError(503));
    await tick();

    const status = agent.getState().status;
    expect(status.type === "streaming" && status.retryStatus).toBeTruthy();

    const done = agent.abort();
    await tick();
    await done;

    expect(events.stopped.map((s) => s.stopReason)).toEqual(["aborted"]);
    expect(events.errors).toHaveLength(0);
    expect(client.streams).toHaveLength(1);
  });
});

describe("OpenAIAgent incomplete responses", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("maps max_output_tokens to max_tokens and still accepts a tool result", async () => {
    const { client, agent, events } = setup();
    agent.appendUserMessage([
      {
        type: "text",
        text: "hello",
        nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
      },
    ]);
    agent.continueConversation();
    const stream = await client.awaitStreamAt(0);
    stream.streamToolCall("call_1", "get_files", { filePath: "a.ts" });
    await tick();
    stream.finishIncomplete("max_output_tokens");
    await tick();

    expect(events.stopped.map((s) => s.stopReason)).toEqual(["max_tokens"]);
    expect(() =>
      agent.toolResult("call_1" as ToolRequestId, {
        type: "tool_result",
        id: "call_1" as ToolRequestId,
        result: { status: "error", error: "interrupted" },
        nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
      }),
    ).not.toThrow();
  });

  it("maps content_filter to content", async () => {
    const { client, agent, events } = setup();
    agent.appendUserMessage([
      {
        type: "text",
        text: "hello",
        nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
      },
    ]);
    agent.continueConversation();
    const stream = await client.awaitStreamAt(0);
    stream.streamText("partial");
    await tick();
    stream.finishIncomplete("content_filter");
    await tick();

    expect(events.stopped.map((s) => s.stopReason)).toEqual(["content"]);
  });
});

function mockFailedResponse() {
  return {
    id: "resp_mock",
    object: "response" as const,
    created_at: 0,
    model: "mock-model",
    status: "failed" as const,
    error: null,
    incomplete_details: null,
    instructions: null,
    metadata: null,
    output: [],
    parallel_tool_calls: true,
    temperature: null,
    tool_choice: "auto" as const,
    tools: [],
    top_p: null,
    output_text: "",
  };
}
