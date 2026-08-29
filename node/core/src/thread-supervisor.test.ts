import { describe, expect, it } from "vitest";
import {
  AutoCompactSupervisor,
  composeSupervisors,
  injectText,
  type RequestContext,
  type ThreadSupervisor,
} from "./thread-supervisor.ts";

const context: RequestContext = {
  kind: "continuation",
  inputTokenCount: 400000,
  stopReason: "end_turn",
};

describe("composeSupervisors onBeforeRequest", () => {
  it("merges the injections in supervisor order", async () => {
    const first: ThreadSupervisor = {
      onBeforeRequest: () => Promise.resolve(injectText("first")),
    };
    const second: ThreadSupervisor = {
      onBeforeRequest: () => Promise.resolve(injectText("second")),
    };
    const hooks = composeSupervisors(() => [first, second]);
    expect(await hooks.onBeforeRequest?.(context)).toEqual({
      injections: [
        { type: "text", text: "first" },
        { type: "text", text: "second" },
      ],
      suspend: undefined,
    });
  });

  it("carries the suspension alongside the injections", async () => {
    const injector: ThreadSupervisor = {
      onBeforeRequest: () => Promise.resolve(injectText("note")),
    };
    const hooks = composeSupervisors(() => [
      injector,
      new AutoCompactSupervisor({ threshold: 300000, nextPrompt: "go" }),
    ]);
    expect(await hooks.onBeforeRequest?.(context)).toEqual({
      injections: [{ type: "text", text: "note" }],
      suspend: { reason: { kind: "compact", nextPrompt: "go" } },
    });
  });

  it("keeps only the first suspension", async () => {
    const hooks = composeSupervisors(() => [
      new AutoCompactSupervisor({ threshold: 300000, nextPrompt: "go" }),
      new AutoCompactSupervisor({ threshold: 300000, nextPrompt: "stop" }),
    ]);
    expect(await hooks.onBeforeRequest?.(context)).toEqual({
      injections: [],
      suspend: { reason: { kind: "compact", nextPrompt: "go" } },
    });
  });

  it("drops `none` actions", async () => {
    const quiet: ThreadSupervisor = {
      onBeforeRequest: () => Promise.resolve({ type: "none" as const }),
    };
    const hooks = composeSupervisors(() => [quiet, {}]);
    expect(await hooks.onBeforeRequest?.(context)).toEqual({
      injections: [],
      suspend: undefined,
    });
  });
});

describe("AutoCompactSupervisor", () => {
  it("suspends for compaction at or over the threshold", async () => {
    const sup = new AutoCompactSupervisor({
      threshold: 300000,
      nextPrompt: "go",
    });
    expect(
      await sup.onBeforeRequest({
        kind: "continuation",
        inputTokenCount: 300000,
        stopReason: "end_turn",
      }),
    ).toEqual({
      type: "suspend",
      reason: { kind: "compact", nextPrompt: "go" },
    });
    expect(
      await sup.onBeforeRequest({
        kind: "continuation",
        inputTokenCount: 400000,
        stopReason: "end_turn",
      }),
    ).toEqual({
      type: "suspend",
      reason: { kind: "compact", nextPrompt: "go" },
    });
  });

  it("returns none below the threshold or without a token count", async () => {
    const sup = new AutoCompactSupervisor({
      threshold: 300000,
      nextPrompt: "go",
    });
    expect(
      await sup.onBeforeRequest({
        kind: "continuation",
        inputTokenCount: 299999,
        stopReason: "end_turn",
      }),
    ).toEqual({ type: "none" });
    expect(
      await sup.onBeforeRequest({
        kind: "continuation",
        inputTokenCount: undefined,
        stopReason: "end_turn",
      }),
    ).toEqual({ type: "none" });
  });

  it("defaults the threshold to 300000", async () => {
    const sup = new AutoCompactSupervisor({ nextPrompt: "go" });
    expect(
      await sup.onBeforeRequest({
        kind: "continuation",
        inputTokenCount: 300000,
        stopReason: "end_turn",
      }),
    ).toEqual({
      type: "suspend",
      reason: { kind: "compact", nextPrompt: "go" },
    });
    expect(
      await sup.onBeforeRequest({
        kind: "continuation",
        inputTokenCount: 299999,
        stopReason: "end_turn",
      }),
    ).toEqual({ type: "none" });
  });
});
