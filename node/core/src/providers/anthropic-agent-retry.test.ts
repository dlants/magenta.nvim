import type Anthropic from "@anthropic-ai/sdk";
import { APIError } from "@anthropic-ai/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "../logger.ts";
import { validateInput } from "../tools/helpers.ts";
import {
  AnthropicAgent,
  type AnthropicAgentOptions,
} from "./anthropic-agent.ts";
import { MockAnthropicClient } from "./mock-anthropic-client.ts";
import type { ProviderToolSpec } from "./provider-types.ts";
import { PLACEHOLDER_NATIVE_MESSAGE_IDX } from "./provider-types.ts";

const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

const defaultOptions = {
  model: "claude-sonnet-4-20250514",
  systemPrompt: "test",
  tools: [] as ProviderToolSpec[],
  skipPostFlightTokenCount: true,
};

const defaultAnthropicOptions: AnthropicAgentOptions = {
  authType: "key",
  includeWebSearch: false,
  disableParallelToolUseFlag: true,
  logger: noopLogger,
  validateInput,
};

function createAgent(mockClient: MockAnthropicClient) {
  return new AnthropicAgent(
    defaultOptions,
    mockClient as unknown as Anthropic,
    defaultAnthropicOptions,
  );
}

function make529Error(): APIError {
  return new APIError(
    529,
    { type: "error", message: "API is temporarily overloaded" },
    "overloaded",
    new Headers(),
  );
}

function make429Error(): APIError {
  return new APIError(
    429,
    { type: "error", message: "Rate limit exceeded" },
    "rate_limited",
    new Headers(),
  );
}

function make400Error(): APIError {
  return new APIError(
    400,
    { type: "error", message: "Bad request" },
    "bad_request",
    new Headers(),
  );
}

/** Collect events from an agent into arrays */
function trackEvents(agent: AnthropicAgent) {
  const events: {
    stopped: Array<{ stopReason: string }>;
    errors: Error[];
    didUpdate: number;
  } = { stopped: [], errors: [], didUpdate: 0 };

  agent.on("stopped", (stopReason) => {
    events.stopped.push({ stopReason });
  });
  agent.on("error", (error) => {
    events.errors.push(error);
  });
  agent.on("didUpdate", () => {
    events.didUpdate++;
  });

  return events;
}

describe("AnthropicAgent retry logic", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("non-retryable errors pass through immediately", async () => {
    const mockClient = new MockAnthropicClient();
    const agent = createAgent(mockClient);
    const events = trackEvents(agent);

    agent.appendUserMessage([{ type: "text", text: "hello", nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX }]);
    agent.continueConversation();

    const stream = await mockClient.awaitStream();
    stream.respondWithError(make400Error());

    // Let microtasks flush
    await vi.advanceTimersByTimeAsync(0);

    expect(events.errors.length).toBe(1);
    expect(events.errors[0]).toBeInstanceOf(APIError);
    expect((events.errors[0] as APIError).status).toBe(400);
    expect(events.stopped.length).toBe(0);
  });

  it("retries on 529 with correct delays and succeeds", async () => {
    const mockClient = new MockAnthropicClient();
    const agent = createAgent(mockClient);
    const events = trackEvents(agent);

    agent.appendUserMessage([{ type: "text", text: "hello", nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX }]);
    agent.continueConversation();

    // First attempt: fail with 529
    let stream = await mockClient.awaitStream();
    stream.respondWithError(make529Error());
    await vi.advanceTimersByTimeAsync(0);

    // Should be in retry state
    const status1 = agent.getState().status;
    expect(status1.type).toBe("streaming");
    if (status1.type === "streaming") {
      expect(status1.retryStatus).toBeDefined();
      expect(status1.retryStatus!.attempt).toBe(1);
    }

    // Advance past first retry delay (1000ms)
    await vi.advanceTimersByTimeAsync(1000);

    // Second attempt: fail with 529
    stream = await mockClient.awaitStream();
    stream.respondWithError(make529Error());
    await vi.advanceTimersByTimeAsync(0);

    const status2 = agent.getState().status;
    expect(status2.type).toBe("streaming");
    if (status2.type === "streaming") {
      expect(status2.retryStatus).toBeDefined();
      expect(status2.retryStatus!.attempt).toBe(2);
    }

    // Advance past second retry delay (5000ms)
    await vi.advanceTimersByTimeAsync(5000);

    // Third attempt: succeed
    stream = await mockClient.awaitStream();
    stream.respond({
      text: "hello!",
      toolRequests: [],
      stopReason: "end_turn",
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(events.stopped.length).toBe(1);
    expect(events.stopped[0].stopReason).toBe("end_turn");
    expect(events.errors.length).toBe(0);
  });

  it("retries on 429", async () => {
    const mockClient = new MockAnthropicClient();
    const agent = createAgent(mockClient);
    const events = trackEvents(agent);

    agent.appendUserMessage([{ type: "text", text: "hello", nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX }]);
    agent.continueConversation();

    // First attempt: fail with 429
    let stream = await mockClient.awaitStream();
    stream.respondWithError(make429Error());
    await vi.advanceTimersByTimeAsync(0);

    const status = agent.getState().status;
    expect(status.type).toBe("streaming");
    if (status.type === "streaming") {
      expect(status.retryStatus).toBeDefined();
    }

    // Advance past retry delay
    await vi.advanceTimersByTimeAsync(1000);

    // Second attempt: succeed
    stream = await mockClient.awaitStream();
    stream.respond({ text: "done", toolRequests: [], stopReason: "end_turn" });
    await vi.advanceTimersByTimeAsync(0);

    expect(events.stopped.length).toBe(1);
    expect(events.errors.length).toBe(0);
  });

  it("gives up after max duration", async () => {
    const mockClient = new MockAnthropicClient();
    const agent = createAgent(mockClient);
    const events = trackEvents(agent);

    agent.appendUserMessage([{ type: "text", text: "hello", nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX }]);
    agent.continueConversation();

    // Simulate time passing beyond MAX_RETRY_DURATION (300s)
    // Fast-forward through multiple retries
    let stream = await mockClient.awaitStream();
    stream.respondWithError(make529Error());
    await vi.advanceTimersByTimeAsync(0);

    // Advance 1000ms for first retry
    await vi.advanceTimersByTimeAsync(1000);
    stream = await mockClient.awaitStream();
    stream.respondWithError(make529Error());
    await vi.advanceTimersByTimeAsync(0);

    // Advance 5000ms for second retry
    await vi.advanceTimersByTimeAsync(5000);
    stream = await mockClient.awaitStream();
    stream.respondWithError(make529Error());
    await vi.advanceTimersByTimeAsync(0);

    // Advance 10000ms for third retry
    await vi.advanceTimersByTimeAsync(10000);
    stream = await mockClient.awaitStream();
    stream.respondWithError(make529Error());
    await vi.advanceTimersByTimeAsync(0);

    // Now retries at 30s intervals. Advance enough to exceed 300s total.
    // We've used 1+5+10 = 16s so far. Need ~284s more = ~10 retries at 30s.
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(30000);
      stream = await mockClient.awaitStream();
      stream.respondWithError(make529Error());
      await vi.advanceTimersByTimeAsync(0);
    }

    // Should have given up by now
    expect(events.errors.length).toBe(1);
    expect(events.stopped.length).toBe(0);
  });

  it("abort during retry wait cancels immediately", async () => {
    const mockClient = new MockAnthropicClient();
    const agent = createAgent(mockClient);
    const events = trackEvents(agent);

    agent.appendUserMessage([{ type: "text", text: "hello", nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX }]);
    agent.continueConversation();

    // First attempt: fail with 529
    const stream = await mockClient.awaitStream();
    stream.respondWithError(make529Error());
    await vi.advanceTimersByTimeAsync(0);

    // Should be in retry wait state
    const status = agent.getState().status;
    expect(status.type).toBe("streaming");
    if (status.type === "streaming") {
      expect(status.retryStatus).toBeDefined();
    }

    // Abort during the retry wait
    await agent.abort();
    await vi.advanceTimersByTimeAsync(0);

    expect(events.stopped.length).toBe(1);
    expect(events.stopped[0].stopReason).toBe("aborted");
    expect(events.errors.length).toBe(0);
  });

  it("status shows retryStatus during wait and clears on retry attempt", async () => {
    const mockClient = new MockAnthropicClient();
    const agent = createAgent(mockClient);

    agent.appendUserMessage([{ type: "text", text: "hello", nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX }]);
    agent.continueConversation();

    // First attempt: fail with 529
    let stream = await mockClient.awaitStream();
    stream.respondWithError(make529Error());
    await vi.advanceTimersByTimeAsync(0);

    // During wait: retryStatus should be set
    const statusDuringWait = agent.getState().status;
    expect(statusDuringWait.type).toBe("streaming");
    if (statusDuringWait.type === "streaming") {
      expect(statusDuringWait.retryStatus).toBeDefined();
      expect(statusDuringWait.retryStatus!.attempt).toBe(1);
      expect(statusDuringWait.retryStatus!.nextRetryAt).toBeInstanceOf(Date);
      expect(statusDuringWait.retryStatus!.error).toBeInstanceOf(APIError);
    }

    // Advance past retry delay
    await vi.advanceTimersByTimeAsync(1000);

    // During retry attempt: retryStatus should be cleared
    const statusDuringRetry = agent.getState().status;
    expect(statusDuringRetry.type).toBe("streaming");
    if (statusDuringRetry.type === "streaming") {
      expect(statusDuringRetry.retryStatus).toBeUndefined();
    }

    // Succeed on second attempt
    stream = await mockClient.awaitStream();
    stream.respond({ text: "ok", toolRequests: [], stopReason: "end_turn" });
    await vi.advanceTimersByTimeAsync(0);

    expect(agent.getState().status.type).toBe("stopped");
  });
});
