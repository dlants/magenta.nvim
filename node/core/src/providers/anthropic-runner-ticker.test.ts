import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "../agent.ts";
import { createTestAgent, flatPhase, userInput } from "../test-helpers.ts";

function start(agent: Agent) {
  return agent.runTurnLoop(userInput("hello"));
}

describe("Agent streaming ticker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("emits updates ~1/sec while waiting and stops after the turn settles", async () => {
    let didUpdate = 0;
    const { agent, mockClient } = createTestAgent({
      onUpdate: () => {
        didUpdate++;
      },
    });

    const turn = start(agent);
    // The loop reaches the request after a few awaits; let them run before
    // polling for the stream (the poll's own retry uses faked timers).
    await vi.advanceTimersByTimeAsync(0);
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
    let didUpdate = 0;
    const { agent, mockClient } = createTestAgent({
      onUpdate: () => {
        didUpdate++;
      },
    });

    const turn = start(agent);
    // The loop reaches the request after a few awaits; let them run before
    // polling for the stream (the poll's own retry uses faked timers).
    await vi.advanceTimersByTimeAsync(0);
    await mockClient.awaitStream();

    await vi.advanceTimersByTimeAsync(2000);
    void agent.abort();
    expect(await turn).toEqual({ type: "aborted" });
    await vi.advanceTimersByTimeAsync(0);

    const afterAbort = didUpdate;
    await vi.advanceTimersByTimeAsync(5000);
    expect(didUpdate).toBe(afterAbort);
  });

  it("advances lastEventTime on each stream event", async () => {
    const { agent, mockClient } = createTestAgent();

    const turn = start(agent);
    // The loop reaches the request after a few awaits; let them run before
    // polling for the stream (the poll's own retry uses faked timers).
    await vi.advanceTimersByTimeAsync(0);
    const stream = await mockClient.awaitStream();

    const initial = flatPhase(agent);
    expect(initial.type).toBe("streaming");
    if (initial.type !== "streaming") return;
    const startEventTime = initial.lastEventTime.getTime();

    // Dead air: lastEventTime should not advance.
    await vi.advanceTimersByTimeAsync(2000);
    const duringWait = flatPhase(agent);
    if (duringWait.type !== "streaming") throw new Error("expected streaming");
    expect(duringWait.lastEventTime.getTime()).toBe(startEventTime);

    // A stream event arrives: lastEventTime should advance to now.
    stream.emitEvent({
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "", citations: null },
    });
    await stream.settle();

    const afterEvent = flatPhase(agent);
    if (afterEvent.type !== "streaming") throw new Error("expected streaming");
    expect(afterEvent.lastEventTime.getTime()).toBeGreaterThan(startEventTime);

    stream.finishResponse("end_turn");
    await turn;
  });
});
