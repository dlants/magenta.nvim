import { APIError } from "openai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "../agent.ts";
import { createTestOpenAIAgent, flatPhase } from "../test-helpers.ts";
import type { ToolName } from "../tool-types.ts";
import type {
  MockOpenAIClient,
  MockResponseStream,
} from "./mock-openai-client.ts";
import {
  type NativeInferenceManager,
  PLACEHOLDER_NATIVE_MESSAGE_IDX,
  type ProviderToolSpec,
  type RequestedTool,
  type RequestUpdate,
  type ToolResults,
  type TurnResult,
} from "./provider-types.ts";

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
  const calls: RequestedTool[][] = [];
  const { agent, mockClient: client } = createTestOpenAIAgent({
    tools: [spec],
    executeTools: (requests: ReadonlyArray<RequestedTool>) => {
      calls.push([...requests]);
      return Promise.resolve({
        type: "continue" as const,
        results: errorResults(requests),
      });
    },
  });
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

/** The loop reaches the request a few awaits in, so let those settle before
 * reading the stream: polling would deadlock against the fake timers. */
async function start(
  client: MockOpenAIClient,
  agent: Agent,
): Promise<{ turn: Promise<TurnResult>; stream: MockResponseStream }> {
  const turn = agent.runTurnLoop([
    {
      type: "text",
      text: "hello",
      nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
    },
  ]);
  await tick();
  return { turn, stream: streamAt(client, 0) };
}

function streamAt(client: MockOpenAIClient, index: number) {
  const stream = client.streams[index];
  if (!stream) throw new Error(`no stream at index ${index}`);
  return stream;
}

describe("OpenAIInferenceManager retry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries a retryable error and discards the partial attempt", async () => {
    const { client, agent } = setup();
    const { turn, stream } = await start(client, agent);

    stream.streamText("half an answer");
    await tick();
    stream.respondWithError(apiError(429));
    await tick();

    const phase = flatPhase(agent);
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

    const messages = agent.manager.log.messages;
    const assistant = messages[messages.length - 1];
    // The half-accumulated text from the failed attempt must not survive.
    expect(assistant.content).toHaveLength(1);
    expect(assistant.content[0]).toMatchObject({
      type: "text",
      text: "the real answer",
    });
  });

  it("re-sends the pre-turn items verbatim after a retry", async () => {
    const { client, agent } = setup();
    const { turn, stream } = await start(client, agent);
    const originalInput = structuredClone(stream.input);
    stream.streamReasoningSummary(["let me think"], {
      itemId: "rs_1",
      encryptedContent: "enc-1",
    });
    stream.streamText("half an answer");
    await tick();
    stream.respondWithError(apiError(429));
    await tick();
    await vi.advanceTimersByTimeAsync(1000);
    const retry = streamAt(client, 1);
    // Items committed by the failed attempt must not be resent alongside the
    // history they were meant to extend.
    expect(retry.input).toEqual(originalInput);
    retry.finishResponse();
    await tick();
    await turn;
  });

  it("surfaces a non-retryable error without retrying", async () => {
    const { client, agent } = setup();
    const { turn, stream } = await start(client, agent);
    stream.respondWithError(apiError(400));
    await tick();

    const result = await turn;
    expect(result.type).toBe("failed");
    expect(client.streams).toHaveLength(1);
  });

  it("treats response.failed as an error", async () => {
    const { client, agent } = setup();
    const { turn, stream } = await start(client, agent);
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
    const { turn, stream } = await start(client, agent);
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
    const { turn, stream } = await start(client, agent);
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
    const { turn, stream } = await start(client, agent);
    stream.respondWithError(apiError(503));
    await tick();

    const phase = flatPhase(agent);
    expect(phase.type === "streaming" && phase.retry).toBeTruthy();

    agent.abort();
    await tick();

    expect(await turn).toEqual({ type: "aborted" });
    expect(client.streams).toHaveLength(1);
  });
});
describe("OpenAIInferenceManager sendRequest", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  /** What `Agent` does: seed the conversation, then issue one request. */
  function send(client: MockOpenAIClient, manager: NativeInferenceManager) {
    const updates: RequestUpdate[] = [];
    manager.appendUserMessage([
      {
        type: "text",
        text: "hello",
        nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
      },
    ]);
    const request = manager.sendRequest((update) => updates.push(update));
    return { request, updates, stream: streamAt(client, 0) };
  }
  it("retries within one request and reports the countdown to the caller", async () => {
    const { client, agent } = setup();
    const { request, updates, stream } = send(client, agent.manager);
    stream.respondWithError(apiError(429));
    await tick();
    const scheduled = updates.filter((u) => u.type === "retry-scheduled");
    expect(scheduled).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000);
    // The fresh attempt clears the countdown.
    expect(
      updates.filter((u) => u.type === "attempt-started").length,
    ).toBeGreaterThan(1);
    const retry = streamAt(client, 1);
    retry.streamText("the real answer");
    await tick();
    retry.finishResponse();
    await tick();
    expect(await request).toEqual({
      type: "stopped",
      stopReason: "end_turn",
    });
  });
  it("aborts an in-flight request and leaves the runner reusable", async () => {
    const { client, agent } = setup();
    const manager = agent.manager;
    const { request, stream } = send(client, manager);
    stream.streamText("half an answer");
    await tick();
    manager.abort();
    // The backend signals a cancellation only by closing the connection.
    stream.abortMidstream();
    await tick();
    expect(await request).toEqual({ type: "aborted" });
    manager.finalize({ type: "aborted" });
    // A second request must be issuable: the first one released the manager.
    const second = manager.sendRequest(() => {});
    await tick();
    streamAt(client, 1).finishResponse();
    await tick();
    expect((await second).type).toBe("stopped");
  });
});

describe("OpenAIInferenceManager incomplete responses", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("maps max_output_tokens to max_tokens and still runs the tool call", async () => {
    const { client, agent, calls } = setup();
    const { turn, stream } = await start(client, agent);
    stream.streamToolCall("call_1", "get_files", { filePath: "a.ts" });
    await tick();
    stream.finishIncomplete("max_output_tokens");
    await tick();

    expect(agent.manager.log.messages[1].stopReason).toBe("max_tokens");
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
    const { turn, stream } = await start(client, agent);
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
