import type Anthropic from "@anthropic-ai/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "../logger.ts";
import { validateInput } from "../tools/helpers.ts";
import {
  AnthropicRunner,
  type AnthropicRunnerOptions,
} from "./anthropic-runner.ts";
import { MockAnthropicClient } from "./mock-anthropic-client.ts";
import type { ProviderToolSpec } from "./provider-types.ts";
import { PLACEHOLDER_NATIVE_MESSAGE_IDX } from "./provider-types.ts";

const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

let onUpdate = () => {};
const noopExecuteTools = () =>
  Promise.reject(new Error("unexpected tool execution"));

const defaultOptions = {
  model: "claude-sonnet-4-20250514",
  systemPrompt: "test",
  tools: [] as ProviderToolSpec[],
  skipPostFlightTokenCount: true,
  executeTools: noopExecuteTools,
  onUpdate: () => onUpdate(),
};

const defaultAnthropicOptions: AnthropicRunnerOptions = {
  authType: "key",
  includeWebSearch: false,
  disableParallelToolUseFlag: true,
  logger: noopLogger,
  validateInput,
};

function createAgent(mockClient: MockAnthropicClient) {
  return new AnthropicRunner(
    defaultOptions,
    mockClient as unknown as Anthropic,
    defaultAnthropicOptions,
  );
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

describe("AnthropicRunner streaming ticker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("emits updates ~1/sec while waiting and stops after the turn settles", async () => {
    const mockClient = new MockAnthropicClient();
    const agent = createAgent(mockClient);
    let didUpdate = 0;
    onUpdate = () => {
      didUpdate++;
    };

    const turn = start(agent);
    const stream = await mockClient.awaitStream();

    // Dead air: no stream events, only the heartbeat should fire.
    const before = didUpdate;
    await vi.advanceTimersByTimeAsync(3000);
    expect(didUpdate - before).toBeGreaterThanOrEqual(3);

    // Complete the turn.
    stream.respond({ text: "done", toolRequests: [], stopReason: "end_turn" });
    expect(await turn).toEqual({ type: "stopped", stopReason: "end_turn" });
    await vi.advanceTimersByTimeAsync(0);

    // Ticker must be cleared: no further emissions after the turn settles.
    const afterSettle = didUpdate;
    await vi.advanceTimersByTimeAsync(5000);
    expect(didUpdate).toBe(afterSettle);
  });

  it("clears the ticker on abort", async () => {
    const mockClient = new MockAnthropicClient();
    const agent = createAgent(mockClient);
    let didUpdate = 0;
    onUpdate = () => {
      didUpdate++;
    };

    const turn = start(agent);
    await mockClient.awaitStream();

    await vi.advanceTimersByTimeAsync(2000);
    agent.abort();
    expect(await turn).toEqual({ type: "aborted" });
    await vi.advanceTimersByTimeAsync(0);

    const afterAbort = didUpdate;
    await vi.advanceTimersByTimeAsync(5000);
    expect(didUpdate).toBe(afterAbort);
  });

  it("advances lastEventTime on each stream event", async () => {
    const mockClient = new MockAnthropicClient();
    const agent = createAgent(mockClient);

    const turn = start(agent);
    const stream = await mockClient.awaitStream();

    const initial = agent.phase;
    expect(initial.type).toBe("streaming");
    if (initial.type !== "streaming") return;
    const startEventTime = initial.lastEventTime.getTime();

    // Dead air: lastEventTime should not advance.
    await vi.advanceTimersByTimeAsync(2000);
    const duringWait = agent.phase;
    if (duringWait.type !== "streaming") throw new Error("expected streaming");
    expect(duringWait.lastEventTime.getTime()).toBe(startEventTime);

    // A stream event arrives: lastEventTime should advance to now.
    stream.emitEvent({
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "", citations: null },
    });
    await stream.settle();

    const afterEvent = agent.phase;
    if (afterEvent.type !== "streaming") throw new Error("expected streaming");
    expect(afterEvent.lastEventTime.getTime()).toBeGreaterThan(startEventTime);

    stream.finishResponse("end_turn");
    await turn;
  });
});
