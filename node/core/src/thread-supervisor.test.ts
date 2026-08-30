import { describe, expect, it } from "vitest";
import {
  AutoCompactSupervisor,
  composeSupervisors,
  type EndTurnContext,
  injectText,
  type RequestContext,
  type ThreadSupervisor,
} from "./thread-supervisor.ts";

const context: RequestContext = {
  kind: "continuation",
  inputTokenCount: 400000,
  isFirstMessage: false,
  outputTokenCount: 0,
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
      type: "proceed",
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
      type: "suspend",
      reason: { kind: "compact", nextPrompt: "go" },
    });
  });

  it("keeps only the first suspension", async () => {
    const hooks = composeSupervisors(() => [
      new AutoCompactSupervisor({ threshold: 300000, nextPrompt: "go" }),
      new AutoCompactSupervisor({ threshold: 300000, nextPrompt: "stop" }),
    ]);
    expect(await hooks.onBeforeRequest?.(context)).toEqual({
      injections: [],
      type: "suspend",
      reason: { kind: "compact", nextPrompt: "go" },
    });
  });

  it("drops `none` actions", async () => {
    const quiet: ThreadSupervisor = {
      onBeforeRequest: () => Promise.resolve({ type: "none" as const }),
    };
    const hooks = composeSupervisors(() => [quiet, {}]);
    expect(await hooks.onBeforeRequest?.(context)).toEqual({
      injections: [],
      type: "proceed",
    });
  });
});

describe("composeSupervisors onEndTurn", () => {
  const endTurnContext: EndTurnContext = {
    stopReason: "end_turn",
    inputTokenCount: 400000,
    lastAssistantMessage: undefined,
  };

  it("lets a suspension win over an accumulated nudge", () => {
    const nudger: ThreadSupervisor = {
      onEndTurnWithoutYield: () => ({
        type: "send-message" as const,
        text: "keep going",
      }),
    };
    const hooks = composeSupervisors(() => [
      nudger,
      new AutoCompactSupervisor({ threshold: 300000, nextPrompt: "go" }),
    ]);
    expect(hooks.onEndTurn?.(endTurnContext)).toEqual({
      type: "suspend",
      reason: { kind: "compact", nextPrompt: "go" },
    });
  });

  it("keeps only the first suspension", () => {
    const hooks = composeSupervisors(() => [
      new AutoCompactSupervisor({ threshold: 300000, nextPrompt: "go" }),
      new AutoCompactSupervisor({ threshold: 300000, nextPrompt: "stop" }),
    ]);
    expect(hooks.onEndTurn?.(endTurnContext)).toEqual({
      type: "suspend",
      reason: { kind: "compact", nextPrompt: "go" },
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
        isFirstMessage: false,
        outputTokenCount: 0,
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
        isFirstMessage: false,
        outputTokenCount: 0,
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
        isFirstMessage: false,
        outputTokenCount: 0,
        stopReason: "end_turn",
      }),
    ).toEqual({ type: "none" });
    expect(
      await sup.onBeforeRequest({
        kind: "continuation",
        inputTokenCount: undefined,
        isFirstMessage: false,
        outputTokenCount: 0,
        stopReason: "end_turn",
      }),
    ).toEqual({ type: "none" });
  });

  it("suspends at a resting end turn only over the threshold", () => {
    const sup = new AutoCompactSupervisor({
      threshold: 300000,
      nextPrompt: "go",
    });
    const at = (inputTokenCount: number | undefined): EndTurnContext => ({
      stopReason: "end_turn",
      inputTokenCount,
      lastAssistantMessage: undefined,
    });
    expect(sup.onEndTurnWithoutYield(at(300000))).toEqual({
      type: "suspend",
      reason: { kind: "compact", nextPrompt: "go" },
    });
    expect(sup.onEndTurnWithoutYield(at(299999))).toEqual({ type: "none" });
    expect(sup.onEndTurnWithoutYield(at(undefined))).toEqual({ type: "none" });
  });

  it("defaults the threshold to 300000", async () => {
    const sup = new AutoCompactSupervisor({ nextPrompt: "go" });
    expect(
      await sup.onBeforeRequest({
        kind: "continuation",
        inputTokenCount: 300000,
        isFirstMessage: false,
        outputTokenCount: 0,
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
        isFirstMessage: false,
        outputTokenCount: 0,
        stopReason: "end_turn",
      }),
    ).toEqual({ type: "none" });
  });
});
