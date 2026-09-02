import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestAgent, flatPhase, sendText } from "../test-helpers.ts";

describe("Agent streaming status", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("emits no updates once an aborted turn settles", async () => {
    let didUpdate = 0;
    const { agent, mockClient } = createTestAgent({
      onUpdate: () => {
        didUpdate++;
      },
    });

    const turn = sendText(agent, "hello");
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

    const turn = sendText(agent, "hello");
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
