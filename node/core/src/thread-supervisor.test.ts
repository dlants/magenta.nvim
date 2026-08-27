import { describe, expect, it } from "vitest";
import {
  AutoCompactSupervisor,
  composeSupervisors,
  injectText,
  type RequestContext,
  type ThreadSupervisor,
} from "./thread-supervisor.ts";

const context: RequestContext = {
  inputTokenCount: 400000,
  stopReason: "end_turn",
};

describe("composeSupervisors onBeforeRequest", () => {
  it("collects the actions in supervisor order", async () => {
    const first: ThreadSupervisor = {
      onBeforeRequest: () => Promise.resolve(injectText("first")),
    };
    const second: ThreadSupervisor = {
      onBeforeRequest: () => Promise.resolve(injectText("second")),
    };
    const hooks = composeSupervisors(() => [first, second]);
    expect(await hooks.onBeforeRequest?.(context)).toEqual([
      { type: "inject", content: [{ type: "text", text: "first" }] },
      { type: "inject", content: [{ type: "text", text: "second" }] },
    ]);
  });

  it("puts a trailing compact after the injections", async () => {
    const injector: ThreadSupervisor = {
      onBeforeRequest: () => Promise.resolve(injectText("note")),
    };
    const hooks = composeSupervisors(() => [
      injector,
      new AutoCompactSupervisor({ threshold: 300000, nextPrompt: "go" }),
    ]);
    expect(await hooks.onBeforeRequest?.(context)).toEqual([
      { type: "inject", content: [{ type: "text", text: "note" }] },
      { type: "compact", nextPrompt: "go" },
    ]);
  });

  it("drops `none` actions", async () => {
    const quiet: ThreadSupervisor = {
      onBeforeRequest: () => Promise.resolve({ type: "none" as const }),
    };
    const hooks = composeSupervisors(() => [quiet, {}]);
    expect(await hooks.onBeforeRequest?.(context)).toEqual([]);
  });
});

describe("AutoCompactSupervisor", () => {
  it("returns compact (with nextPrompt) at or over the threshold", async () => {
    const sup = new AutoCompactSupervisor({
      threshold: 300000,
      nextPrompt: "go",
    });
    expect(
      await sup.onBeforeRequest({
        inputTokenCount: 300000,
        stopReason: "end_turn",
      }),
    ).toEqual({ type: "compact", nextPrompt: "go" });
    expect(
      await sup.onBeforeRequest({
        inputTokenCount: 400000,
        stopReason: "end_turn",
      }),
    ).toEqual({ type: "compact", nextPrompt: "go" });
  });

  it("returns none below the threshold or without a token count", async () => {
    const sup = new AutoCompactSupervisor({
      threshold: 300000,
      nextPrompt: "go",
    });
    expect(
      await sup.onBeforeRequest({
        inputTokenCount: 299999,
        stopReason: "end_turn",
      }),
    ).toEqual({ type: "none" });
    expect(
      await sup.onBeforeRequest({
        inputTokenCount: undefined,
        stopReason: "end_turn",
      }),
    ).toEqual({ type: "none" });
  });

  it("defaults the threshold to 300000", async () => {
    const sup = new AutoCompactSupervisor({ nextPrompt: "go" });
    expect(
      await sup.onBeforeRequest({
        inputTokenCount: 300000,
        stopReason: "end_turn",
      }),
    ).toEqual({ type: "compact", nextPrompt: "go" });
    expect(
      await sup.onBeforeRequest({
        inputTokenCount: 299999,
        stopReason: "end_turn",
      }),
    ).toEqual({ type: "none" });
  });
});
