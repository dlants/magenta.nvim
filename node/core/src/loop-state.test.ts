import { describe, expect, it } from "vitest";
import { LoopStateMachine } from "./loop-state.ts";
import type { SendResult } from "./thread-api.ts";

const machine = () => new LoopStateMachine(() => {});

/** The send an activity belongs to; these transition tests never await it. */
const neverSettles = new Promise<SendResult>(() => {});

const completed: SendResult = { type: "completed", stopReason: "end_turn" };

describe("LoopStateMachine", () => {
  it("keeps the aborting flag across activity transitions and clears it at idle", () => {
    const loop = machine();
    const epoch = loop.start();
    loop.streaming(neverSettles);
    loop.markAborting();
    expect(loop.isAborting()).toBe(true);

    loop.runningTools([]);
    expect(loop.current).toMatchObject({
      type: "running",
      aborting: true,
      activity: { type: "running_tools" },
    });

    loop.streaming(neverSettles);
    expect(loop.isEpochAborting(epoch)).toBe(true);

    loop.applyRequestUpdate({ type: "attempt-started" });
    expect(loop.isAborting()).toBe(true);

    loop.finish(epoch, completed);
    expect(loop.current).toEqual({ type: "idle", lastResult: completed });
    expect(loop.isAborting()).toBe(false);
  });

  it("ignores writes from a superseded epoch", () => {
    const loop = machine();
    const first = loop.start();
    loop.streaming(neverSettles);
    const second = loop.start();

    expect(loop.isCurrent(first)).toBe(false);
    expect(loop.isEpochAborting(first)).toBe(false);

    loop.finish(first, { type: "aborted" });
    expect(loop.current).toMatchObject({ type: "running", epoch: second });

    loop.finish(second, completed);
    expect(loop.current).toEqual({ type: "idle", lastResult: completed });
  });

  it("starts each loop with a clear aborting flag", () => {
    const loop = machine();
    const first = loop.start();
    loop.markAborting();
    loop.finish(first, { type: "aborted" });

    loop.start();
    expect(loop.isAborting()).toBe(false);
  });

  it("ignores a tool batch announced outside a tracked send", () => {
    const loop = machine();
    loop.runningTools([]);
    expect(loop.current).toEqual({ type: "idle", lastResult: undefined });

    loop.start();
    loop.runningTools([]);
    expect(loop.current).toMatchObject({ activity: { type: "preparing" } });
  });

  it("returns a settled batch to its own send, and is inert without one", () => {
    const loop = machine();
    loop.start();
    loop.streaming(neverSettles);
    loop.runningTools([]);

    loop.toolsSettled();
    expect(loop.current).toMatchObject({
      activity: { type: "streaming", send: neverSettles },
    });

    loop.preparing();
    loop.toolsSettled();
    expect(loop.current).toMatchObject({ activity: { type: "preparing" } });
  });

  it("drops request updates that arrive while tools are running", () => {
    const loop = machine();
    loop.start();
    loop.streaming(neverSettles);
    loop.runningTools([]);

    loop.applyRequestUpdate({ type: "attempt-started" });
    expect(loop.current).toMatchObject({
      activity: { type: "running_tools" },
    });
  });
});
