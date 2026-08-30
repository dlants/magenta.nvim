import { APIError } from "openai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolName } from "../tool-types.ts";
import { validateInput } from "../tools/helpers.ts";
import { MockOpenAIClient } from "./mock-openai-client.ts";
import { OpenAIRunner, type OpenAIStreamingClient } from "./openai-runner.ts";
import {
  PLACEHOLDER_NATIVE_MESSAGE_IDX,
  type ProviderToolSpec,
  type RequestedTool,
  type ToolResults,
  type TurnResult,
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

/** Answers every request with an error result, which is all these tests need
 * of a tool executor: they are about the request/retry loop, not the tools. */
function errorResults(requests: ReadonlyArray<RequestedTool>): ToolResults {
  return new Map(
    requests.map((request) => [
      request.id,
      { status: "error" as const, error: "interrupted" },
    ]),
  );
}

function setup() {
  const client = new MockOpenAIClient();
  const calls: RequestedTool[][] = [];
  const agent = new OpenAIRunner(
    {
      model: "gpt-5.4",
      systemPrompt: "be helpful",
      tools: [spec],
      executeTools: (requests) => {
        calls.push([...requests]);
        return Promise.resolve({
          type: "continue",
          results: errorResults(requests),
        });
      },
      onUpdate: () => {},
    },
    client as unknown as OpenAIStreamingClient,
    { includeWebSearch: false, logger: noopLogger, validateInput },
  );
  return { client, agent, calls };
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

function start(
  client: MockOpenAIClient,
  agent: OpenAIRunner,
): { turn: Promise<TurnResult>; stream: ReturnType<typeof streamAt> } {
  const turn = agent.runTurn([
    {
      type: "text",
      text: "hello",
      nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
    },
  ]);
  return { turn, stream: streamAt(client, 0) };
}

/** `runTurn` opens its first stream synchronously, so no polling (which would
 * deadlock against the fake timers) is needed. */
function streamAt(client: MockOpenAIClient, index: number) {
  const stream = client.streams[index];
  if (!stream) throw new Error(`no stream at index ${index}`);
  return stream;
}

describe("OpenAIRunner retry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries a retryable error and discards the partial attempt", async () => {
    const { client, agent } = setup();
    const { turn, stream } = start(client, agent);

    stream.streamText("half an answer");
    await tick();
    stream.respondWithError(apiError(429));
    await tick();

    const phase = agent.phase;
    expect(phase.type).toBe("streaming");
    if (phase.type === "streaming") {
      expect(phase.retry?.attempt).toBe(1);
    }

    await vi.advanceTimersByTimeAsync(1000);
    const retry = streamAt(client, 1);
    retry.streamText("the real answer");
    await tick();
    retry.finishResponse();
    await tick();

    expect(await turn).toEqual({ type: "stopped", stopReason: "end_turn" });

    const messages = agent.log.messages;
    const assistant = messages[messages.length - 1];
    // The half-accumulated text from the failed attempt must not survive.
    expect(assistant.content).toHaveLength(1);
    expect(assistant.content[0]).toMatchObject({
      type: "text",
      text: "the real answer",
    });
  });

  it("surfaces a non-retryable error without retrying", async () => {
    const { client, agent } = setup();
    const { turn, stream } = start(client, agent);
    stream.respondWithError(apiError(400));
    await tick();

    const result = await turn;
    expect(result.type).toBe("failed");
    expect(client.streams).toHaveLength(1);
  });

  it("treats response.failed as an error", async () => {
    const { client, agent } = setup();
    const { turn, stream } = start(client, agent);
    stream.emitEvent({
      type: "response.failed",
      response: {
        ...mockFailedResponse(),
        error: { code: "server_error", message: "backend exploded" },
      },
    });
    await tick();

    const result = await turn;
    expect(result.type).toBe("failed");
    if (result.type === "failed") {
      expect(result.error.message).toBe("backend exploded");
    }
  });

  it("falls back to a generic message when response.failed carries no error", async () => {
    const { client, agent } = setup();
    const { turn, stream } = start(client, agent);
    stream.emitEvent({
      type: "response.failed",
      response: mockFailedResponse(),
    });
    await tick();

    const result = await turn;
    expect(result.type).toBe("failed");
    if (result.type === "failed") {
      expect(result.error.message).toBe("response.failed");
    }
  });

  it("treats an `error` stream event as an error", async () => {
    const { client, agent } = setup();
    const { turn, stream } = start(client, agent);
    stream.emitEvent({
      type: "error",
      code: "rate_limit",
      message: "slow down",
      param: null,
    });
    await tick();

    const result = await turn;
    expect(result.type).toBe("failed");
    if (result.type === "failed") {
      expect(result.error.message).toBe("slow down");
    }
  });

  it("aborting during the backoff sleep unwinds the turn", async () => {
    const { client, agent } = setup();
    const { turn, stream } = start(client, agent);
    stream.respondWithError(apiError(503));
    await tick();

    const phase = agent.phase;
    expect(phase.type === "streaming" && phase.retry).toBeTruthy();

    agent.abort();
    await tick();

    expect(await turn).toEqual({ type: "aborted" });
    expect(client.streams).toHaveLength(1);
  });
});

describe("OpenAIRunner incomplete responses", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("maps max_output_tokens to max_tokens and still runs the tool call", async () => {
    const { client, agent, calls } = setup();
    const { turn, stream } = start(client, agent);
    stream.streamToolCall("call_1", "get_files", { filePath: "a.ts" });
    await tick();
    stream.finishIncomplete("max_output_tokens");
    await tick();

    expect(agent.log.messages[1].stopReason).toBe("max_tokens");
    expect(calls.map((batch) => batch.map((request) => request.id))).toEqual([
      ["call_1"],
    ]);

    // A truncated turn still answers the tool call and continues.
    const followup = streamAt(client, 1);
    expect(followup.inputItemsOfType("function_call_output")).toMatchObject([
      { call_id: "call_1", output: "interrupted" },
    ]);
    followup.finishResponse();
    await tick();
    expect(await turn).toEqual({ type: "stopped", stopReason: "end_turn" });
  });

  it("maps content_filter to content", async () => {
    const { client, agent } = setup();
    const { turn, stream } = start(client, agent);
    stream.streamText("partial");
    await tick();
    stream.finishIncomplete("content_filter");
    await tick();

    expect(await turn).toEqual({ type: "stopped", stopReason: "content" });
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
