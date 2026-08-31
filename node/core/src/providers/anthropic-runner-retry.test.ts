import { AnthropicError, APIError } from "@anthropic-ai/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "../agent.ts";
import {
  agentHooks,
  createTestAgent,
  flatPhase,
  userInput,
} from "../test-helpers.ts";
import { isRetryableError } from "./anthropic-runner.ts";

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

function start(agent: Agent) {
  return agent.runTurnLoop(userInput("hello"));
}

describe("isRetryableError", () => {
  it("retries mid-stream overloaded_error (undefined status)", () => {
    const error = new APIError(
      undefined,
      {
        type: "error",
        error: { type: "overloaded_error", message: "Overloaded" },
      },
      "Overloaded",
      new Headers(),
      "overloaded_error",
    );
    expect(isRetryableError(error)).toBe(true);
  });

  it("retries mid-stream api_error (undefined status)", () => {
    const error = new APIError(
      undefined,
      { type: "error", error: { type: "api_error", message: "Internal" } },
      "Internal",
      new Headers(),
      "api_error",
    );
    expect(isRetryableError(error)).toBe(true);
  });

  it("retries 429 and 529 status errors", () => {
    expect(isRetryableError(make429Error())).toBe(true);
    expect(isRetryableError(make529Error())).toBe(true);
  });

  it("retries Bedrock stream ending without any chunks", () => {
    const error = new AnthropicError(
      "request ended without sending any chunks",
    );
    expect(isRetryableError(error)).toBe(true);
  });

  it("retries a generic connection-drop error with message 'terminated'", () => {
    expect(isRetryableError(new Error("terminated"))).toBe(true);
    expect(isRetryableError(new TypeError("terminated"))).toBe(true);
  });

  it("does not retry an unrelated bare Error message", () => {
    expect(isRetryableError(new Error("terminated unexpectedly"))).toBe(false);
    expect(isRetryableError(new Error("some other failure"))).toBe(false);
  });

  it("does not retry non-retryable errors", () => {
    const error = new APIError(
      400,
      {
        type: "error",
        error: { type: "invalid_request_error", message: "bad" },
      },
      "bad",
      new Headers(),
      "invalid_request_error",
    );
    expect(isRetryableError(error)).toBe(false);
  });
});

describe("Agent retry logic", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("non-retryable errors pass through immediately", async () => {
    const { agent, mockClient } = createTestAgent();

    const turn = start(agent);
    // The loop reaches the request after a few awaits; let them run before
    // polling for the stream (the poll's own retry uses faked timers).
    await vi.advanceTimersByTimeAsync(0);

    const stream = await mockClient.awaitStream();
    stream.respondWithError(make400Error());

    // Let microtasks flush
    await vi.advanceTimersByTimeAsync(0);

    const result = await turn;
    if (result.type !== "failed") throw new Error("expected failed");
    expect(result.error).toBeInstanceOf(APIError);
    expect((result.error as APIError).status).toBe(400);
  });

  it("does not re-fire the before-request gate, or re-count, on a retried request", async () => {
    let calls = 0;
    const { agent, mockClient } = createTestAgent({
      getHooks: () =>
        agentHooks({
          onBeforeRequest: [
            {
              requestPreflightTokenCount: true,
              run: () => {
                calls++;
                return Promise.resolve({ type: "none" as const });
              },
            },
          ],
        }),
    });
    const turn = start(agent);
    await vi.advanceTimersByTimeAsync(0);
    let stream = await mockClient.awaitStream();
    stream.respondWithError(make529Error());
    await vi.advanceTimersByTimeAsync(1000);
    stream = await mockClient.awaitStream();
    stream.streamText("ok");
    stream.finishResponse("end_turn");
    await vi.advanceTimersByTimeAsync(0);
    expect(await turn).toEqual({ type: "stopped", stopReason: "end_turn" });
    expect(calls).toBe(1);
    // The retry stays inside one `sendRequest`, so the count taken for the
    // request it describes is still current.
    expect(mockClient.countTokensCalls).toBe(1);
  });

  it("retries on 529 with correct delays and succeeds", async () => {
    const { agent, mockClient } = createTestAgent();

    const turn = start(agent);
    // The loop reaches the request after a few awaits; let them run before
    // polling for the stream (the poll's own retry uses faked timers).
    await vi.advanceTimersByTimeAsync(0);

    // First attempt: fail with 529
    let stream = await mockClient.awaitStream();
    stream.respondWithError(make529Error());
    await vi.advanceTimersByTimeAsync(0);

    // Should be in retry state
    const status1 = flatPhase(agent);
    expect(status1.type).toBe("streaming");
    if (status1.type === "streaming") {
      expect(status1.retry).toBeDefined();
      expect(status1.retry!.attempt).toBe(1);
    }

    // Advance past first retry delay (1000ms)
    await vi.advanceTimersByTimeAsync(1000);

    // Second attempt: fail with 529
    stream = await mockClient.awaitStream();
    stream.respondWithError(make529Error());
    await vi.advanceTimersByTimeAsync(0);

    const status2 = flatPhase(agent);
    expect(status2.type).toBe("streaming");
    if (status2.type === "streaming") {
      expect(status2.retry).toBeDefined();
      expect(status2.retry!.attempt).toBe(2);
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

    expect(await turn).toEqual({ type: "stopped", stopReason: "end_turn" });
  });

  it("retries on transient SSE JSON parse errors", async () => {
    const { agent, mockClient } = createTestAgent();

    const turn = start(agent);
    // The loop reaches the request after a few awaits; let them run before
    // polling for the stream (the poll's own retry uses faked timers).
    await vi.advanceTimersByTimeAsync(0);

    // First attempt: SDK surfaces a malformed SSE frame as an AnthropicError
    let stream = await mockClient.awaitStream();
    stream.respondWithError(
      new AnthropicError(
        "Expected ',' or '}' after property value in JSON at position 99 (line 1 column 100)",
      ),
    );
    await vi.advanceTimersByTimeAsync(0);

    const status = flatPhase(agent);
    expect(status.type).toBe("streaming");
    if (status.type === "streaming") {
      expect(status.retry).toBeDefined();
    }

    // Advance past retry delay, then succeed
    await vi.advanceTimersByTimeAsync(1000);
    stream = await mockClient.awaitStream();
    stream.respond({ text: "done", toolRequests: [], stopReason: "end_turn" });
    await vi.advanceTimersByTimeAsync(0);

    expect(await turn).toEqual({ type: "stopped", stopReason: "end_turn" });
  });

  it("retries on 429", async () => {
    const { agent, mockClient } = createTestAgent();

    const turn = start(agent);
    // The loop reaches the request after a few awaits; let them run before
    // polling for the stream (the poll's own retry uses faked timers).
    await vi.advanceTimersByTimeAsync(0);

    // First attempt: fail with 429
    let stream = await mockClient.awaitStream();
    stream.respondWithError(make429Error());
    await vi.advanceTimersByTimeAsync(0);

    const status = flatPhase(agent);
    expect(status.type).toBe("streaming");
    if (status.type === "streaming") {
      expect(status.retry).toBeDefined();
    }

    // Advance past retry delay
    await vi.advanceTimersByTimeAsync(1000);

    // Second attempt: succeed
    stream = await mockClient.awaitStream();
    stream.respond({ text: "done", toolRequests: [], stopReason: "end_turn" });
    await vi.advanceTimersByTimeAsync(0);

    expect(await turn).toEqual({ type: "stopped", stopReason: "end_turn" });
  });

  it("gives up after max duration", async () => {
    const { agent, mockClient } = createTestAgent();

    const turn = start(agent);
    // The loop reaches the request after a few awaits; let them run before
    // polling for the stream (the poll's own retry uses faked timers).
    await vi.advanceTimersByTimeAsync(0);

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
    const result = await turn;
    expect(result.type).toBe("failed");
  });

  it("recovers when a retryable error interrupts a stream mid-block", async () => {
    // Regression: a previous attempt that errored after opening a content
    // block (but before closing it) used to leave currentBlockIndex set, so
    // the next attempt's content_block_start collided with the still-open
    // block and threw "content_block_start ... while block N is still open".
    const { agent, mockClient } = createTestAgent();

    const turn = start(agent);
    // The loop reaches the request after a few awaits; let them run before
    // polling for the stream (the poll's own retry uses faked timers).
    await vi.advanceTimersByTimeAsync(0);

    // First attempt: open block 0, then error mid-block with a retryable status
    let stream = await mockClient.awaitStream();
    stream.emitEvent({
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "", citations: null },
    });
    await stream.settle();
    stream.respondWithError(make529Error());
    await vi.advanceTimersByTimeAsync(0);

    const status = flatPhase(agent);
    expect(status.type).toBe("streaming");
    if (status.type === "streaming") {
      expect(status.retry).toBeDefined();
    }

    // Second attempt: fresh stream reopens block 0 and succeeds
    await vi.advanceTimersByTimeAsync(1000);
    stream = await mockClient.awaitStream();
    stream.respond({ text: "done", toolRequests: [], stopReason: "end_turn" });
    await vi.advanceTimersByTimeAsync(0);

    expect(await turn).toEqual({ type: "stopped", stopReason: "end_turn" });
  });

  it("abort during retry wait cancels immediately", async () => {
    const { agent, mockClient } = createTestAgent();

    const turn = start(agent);
    // The loop reaches the request after a few awaits; let them run before
    // polling for the stream (the poll's own retry uses faked timers).
    await vi.advanceTimersByTimeAsync(0);

    // First attempt: fail with 529
    const stream = await mockClient.awaitStream();
    stream.respondWithError(make529Error());
    await vi.advanceTimersByTimeAsync(0);

    // Should be in retry wait state
    const status = flatPhase(agent);
    expect(status.type).toBe("streaming");
    if (status.type === "streaming") {
      expect(status.retry).toBeDefined();
    }

    // Abort during the retry wait
    void agent.abort();
    await vi.advanceTimersByTimeAsync(0);

    expect(await turn).toEqual({ type: "aborted" });
  });

  it("status shows retry during wait and clears on retry attempt", async () => {
    const { agent, mockClient } = createTestAgent();

    const turn = start(agent);
    // The loop reaches the request after a few awaits; let them run before
    // polling for the stream (the poll's own retry uses faked timers).
    await vi.advanceTimersByTimeAsync(0);

    // First attempt: fail with 529
    let stream = await mockClient.awaitStream();
    stream.respondWithError(make529Error());
    await vi.advanceTimersByTimeAsync(0);

    // During wait: retry should be set
    const statusDuringWait = flatPhase(agent);
    expect(statusDuringWait.type).toBe("streaming");
    if (statusDuringWait.type === "streaming") {
      expect(statusDuringWait.retry).toBeDefined();
      expect(statusDuringWait.retry!.attempt).toBe(1);
      expect(statusDuringWait.retry!.nextRetryAt).toBeInstanceOf(Date);
      expect(statusDuringWait.retry!.error).toBeInstanceOf(APIError);
    }

    // Advance past retry delay
    await vi.advanceTimersByTimeAsync(1000);

    // During retry attempt: retry should be cleared
    const statusDuringRetry = flatPhase(agent);
    expect(statusDuringRetry.type).toBe("streaming");
    if (statusDuringRetry.type === "streaming") {
      expect(statusDuringRetry.retry).toBeUndefined();
    }

    // Succeed on second attempt
    stream = await mockClient.awaitStream();
    stream.respond({ text: "ok", toolRequests: [], stopReason: "end_turn" });
    await vi.advanceTimersByTimeAsync(0);

    expect(await turn).toEqual({ type: "stopped", stopReason: "end_turn" });
    expect(flatPhase(agent).type).toBe("idle");
  });
});
