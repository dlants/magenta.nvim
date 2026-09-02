import { describe, expect, it } from "vitest";
import { LoopStateMachine } from "./loop-state.ts";
import type { SendResult } from "./thread-api.ts";

const machine = () => new LoopStateMachine(() => {});

/** The send an activity belongs to; these transition tests never await it. */
const neverSettles = new Promise<SendResult>(() => {});

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

    loop.finish(epoch);
    expect(loop.current).toEqual({ type: "idle" });
    expect(loop.isAborting()).toBe(false);
  });

  it("ignores writes from a superseded epoch", () => {
    const loop = machine();
    const first = loop.start();
    loop.streaming(neverSettles);
    const second = loop.start();

    expect(loop.isCurrent(first)).toBe(false);
    expect(loop.isEpochAborting(first)).toBe(false);

    loop.finish(first);
    expect(loop.current).toMatchObject({ type: "running", epoch: second });

    loop.finish(second);
    expect(loop.current).toEqual({ type: "idle" });
  });

  it("starts each loop with a clear aborting flag", () => {
    const loop = machine();
    const first = loop.start();
    loop.markAborting();
    loop.finish(first);

    loop.start();
    expect(loop.isAborting()).toBe(false);
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
