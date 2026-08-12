import type Anthropic from "@anthropic-ai/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "../logger.ts";
import { validateInput } from "../tools/helpers.ts";
import {
  AnthropicRunner,
  type AnthropicRunnerOptions,
} from "./anthropic-runner.ts";
import {
  makeRefreshAuth,
  type RefreshAuth,
  type RunCommand,
} from "./auth-refresh.ts";
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
  executeTools: () => Promise.reject(new Error("unexpected tool execution")),
  onUpdate: () => {},
};

function createAgent(
  mockClient: MockAnthropicClient,
  refreshAuth: RefreshAuth | undefined,
): AnthropicRunner {
  const opts: AnthropicRunnerOptions = {
    authType: "key",
    includeWebSearch: false,
    disableParallelToolUseFlag: true,
    logger: noopLogger,
    validateInput,
    refreshAuth,
  };
  return new AnthropicRunner(
    defaultOptions,
    mockClient as unknown as Anthropic,
    opts,
  );
}

function makeTokenExpiredError(): Error {
  const err = new Error(
    "Token is expired. To refresh this SSO session run 'aws sso login'.",
  );
  err.name = "TokenProviderError";
  return err;
}

function start(agent: AnthropicRunner) {
  return agent.runTurn([
    {
      type: "text",
      text: "hello",
      nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
    },
  ]);
}

describe("AnthropicRunner auth refresh", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("refreshes auth on TokenProviderError and retries successfully", async () => {
    const mockClient = new MockAnthropicClient();
    const refreshAuth = vi.fn().mockResolvedValue(undefined);
    const agent = createAgent(mockClient, refreshAuth);

    const turn = start(agent);

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
    const mockClient = new MockAnthropicClient();
    const refreshAuth = vi
      .fn()
      .mockRejectedValue(new Error("aws sso login failed: bad config"));
    const agent = createAgent(mockClient, refreshAuth);

    const turn = start(agent);

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
    const mockClient = new MockAnthropicClient();
    const runCommand = vi
      .fn<RunCommand>()
      .mockResolvedValue({ stdout: "", stderr: "" });
    const refreshAuth = makeRefreshAuth(
      "aws sso login",
      noopLogger,
      runCommand,
    );
    const agent = createAgent(mockClient, refreshAuth);

    const turn = start(agent);

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
