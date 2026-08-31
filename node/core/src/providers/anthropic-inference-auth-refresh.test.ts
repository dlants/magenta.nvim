import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "../agent.ts";
import type { Logger } from "../logger.ts";
import { createTestAgent, userInput } from "../test-helpers.ts";
import {
  makeRefreshAuth,
  type RefreshAuth,
  type RunCommand,
} from "./auth-refresh.ts";

const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

function createAgent(refreshAuth: RefreshAuth | undefined) {
  return createTestAgent({ anthropicOptions: { refreshAuth } });
}

function makeTokenExpiredError(): Error {
  const err = new Error(
    "Token is expired. To refresh this SSO session run 'aws sso login'.",
  );
  err.name = "TokenProviderError";
  return err;
}

function start(agent: Agent) {
  return agent.runTurnLoop(userInput("hello"));
}

describe("Agent auth refresh", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("refreshes auth on TokenProviderError and retries successfully", async () => {
    const refreshAuth = vi.fn().mockResolvedValue(undefined);
    const { agent, mockClient } = createAgent(refreshAuth);

    const turn = start(agent);
    // The loop reaches the request after a few awaits; let them run before
    // polling for the stream (the poll's own retry uses faked timers).
    await vi.advanceTimersByTimeAsync(0);

    let stream = await mockClient.awaitStream();
    stream.respondWithError(makeTokenExpiredError());
    await vi.advanceTimersByTimeAsync(0);

    stream = await mockClient.awaitStream();
    stream.respond({
      text: "hi back",
      toolRequests: [],
      stopReason: "end_turn",
    });

    expect(await turn).toEqual({ type: "stopped", stopReason: "end_turn" });
    expect(refreshAuth).toHaveBeenCalledTimes(1);
  });

  it("surfaces a combined error when refresh fails", async () => {
    const refreshAuth = vi
      .fn()
      .mockRejectedValue(new Error("aws sso login failed: bad config"));
    const { agent, mockClient } = createAgent(refreshAuth);

    const turn = start(agent);
    // The loop reaches the request after a few awaits; let them run before
    // polling for the stream (the poll's own retry uses faked timers).
    await vi.advanceTimersByTimeAsync(0);

    const stream = await mockClient.awaitStream();
    stream.respondWithError(makeTokenExpiredError());

    const result = await turn;
    expect(refreshAuth).toHaveBeenCalledTimes(1);
    if (result.type !== "failed") throw new Error("expected failed");
    expect(result.error.message).toContain("Auth refresh failed");
    expect(result.error.message).toContain("bad config");
    expect(result.error.message).toContain("Token is expired");
  });

  it("30s window prevents a second refresh after a repeated auth error", async () => {
    const runCommand = vi
      .fn<RunCommand>()
      .mockResolvedValue({ stdout: "", stderr: "" });
    const refreshAuth = makeRefreshAuth(
      "aws sso login",
      noopLogger,
      runCommand,
    );
    const { agent, mockClient } = createAgent(refreshAuth);

    const turn = start(agent);
    // The loop reaches the request after a few awaits; let them run before
    // polling for the stream (the poll's own retry uses faked timers).
    await vi.advanceTimersByTimeAsync(0);

    let stream = await mockClient.awaitStream();
    stream.respondWithError(makeTokenExpiredError());
    await vi.advanceTimersByTimeAsync(0);

    stream = await mockClient.awaitStream();
    stream.respondWithError(makeTokenExpiredError());

    const result = await turn;
    expect(runCommand).toHaveBeenCalledTimes(1);
    if (result.type !== "failed") throw new Error("expected failed");
    expect(result.error.message).toContain("Auth refresh failed");
    expect(result.error.message).toContain("not retrying");
  });
});
