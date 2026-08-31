import { APIConnectionError } from "openai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "../agent.ts";
import type { Logger } from "../logger.ts";
import { createTestOpenAIAgent } from "../test-helpers.ts";
import {
  makeRefreshAuth,
  type RefreshAuth,
  type RunCommand,
} from "./auth-refresh.ts";
import type { MockOpenAIClient } from "./mock-openai-client.ts";
import {
  PLACEHOLDER_NATIVE_MESSAGE_IDX,
  type TurnResult,
} from "./provider-types.ts";

const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

function setup(refreshAuth: RefreshAuth | undefined) {
  return createTestOpenAIAgent({ openaiOptions: { refreshAuth } });
}

/** How an expired SSO session actually reaches the manager: the AWS credential
 * chain throws inside the SigV4 fetch, and the OpenAI SDK reports that as a
 * connection error with the real failure as `cause`. */
function makeWrappedTokenError(): Error {
  const cause = new Error(
    "Token is expired. To refresh this SSO session run 'aws sso login'.",
  );
  cause.name = "TokenProviderError";
  return new APIConnectionError({ cause });
}

/** Let the SDK's stream reader drain and the agent's microtasks settle. */
async function tick(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) {
    await vi.advanceTimersByTimeAsync(0);
  }
}

/** The loop reaches the request a few awaits in, so let those settle before
 * reading the stream: polling would deadlock against the fake timers. */
async function start(agent: Agent): Promise<{ turn: Promise<TurnResult> }> {
  const turn = agent.runTurnLoop([
    {
      type: "text",
      text: "hello",
      nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
    },
  ]);
  await tick();
  // Wrapped, since returning the promise from an async function would await it.
  return { turn };
}

function streamAt(client: MockOpenAIClient, index: number) {
  const stream = client.streams[index];
  if (!stream) throw new Error(`no stream at index ${index}`);
  return stream;
}

describe("OpenAIInferenceManager auth refresh", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("refreshes auth on a wrapped credentials error and retries successfully", async () => {
    const refreshAuth = vi.fn().mockResolvedValue(undefined);
    const { agent, mockClient } = setup(refreshAuth);
    const { turn } = await start(agent);

    streamAt(mockClient, 0).streamText("half an answer");
    await tick();
    streamAt(mockClient, 0).respondWithError(makeWrappedTokenError());
    await tick();

    const retry = streamAt(mockClient, 1);
    retry.streamText("the real answer");
    await tick();
    retry.finishResponse();
    await tick();

    expect(await turn).toEqual({ type: "stopped", stopReason: "end_turn" });
    expect(refreshAuth).toHaveBeenCalledTimes(1);

    // The partial text from the failed attempt must not survive the retry.
    const messages = agent.getMessages();
    expect(messages[messages.length - 1].content).toMatchObject([
      { type: "text", text: "the real answer" },
    ]);
  });

  it("surfaces the wrapped cause when no refresh command is configured", async () => {
    const { agent, mockClient } = setup(undefined);
    const { turn } = await start(agent);

    streamAt(mockClient, 0).respondWithError(makeWrappedTokenError());
    await tick();

    const result = await turn;
    if (result.type !== "failed") throw new Error("expected failed");
    expect(result.error.message).toContain("Connection error.");
    expect(result.error.message).toContain("Token is expired");
    expect(mockClient.streams).toHaveLength(1);
  });

  it("surfaces a combined error when refresh fails", async () => {
    const refreshAuth = vi
      .fn()
      .mockRejectedValue(new Error("aws sso login failed: bad config"));
    const { agent, mockClient } = setup(refreshAuth);
    const { turn } = await start(agent);

    streamAt(mockClient, 0).respondWithError(makeWrappedTokenError());
    await tick();

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
    const { agent, mockClient } = setup(refreshAuth);
    const { turn } = await start(agent);

    streamAt(mockClient, 0).respondWithError(makeWrappedTokenError());
    await tick();
    streamAt(mockClient, 1).respondWithError(makeWrappedTokenError());
    await tick();

    const result = await turn;
    expect(runCommand).toHaveBeenCalledTimes(1);
    if (result.type !== "failed") throw new Error("expected failed");
    expect(result.error.message).toContain("Auth refresh failed");
    expect(result.error.message).toContain("not retrying");
  });
});
