import { describe, expect, it } from "vitest";
import type { SystemInfo } from "./providers/system-prompt.ts";
import {
  AutoCompactSupervisor,
  composeSupervisors,
  type EndTurnContext,
  injectText,
  type RequestContext,
  SystemInfoSupervisor,
  type ThreadSupervisor,
} from "./thread-supervisor.ts";

const context: RequestContext = {
  inputTokenCount: 400000,
  outputTokenCount: 0,
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

describe("composeSupervisors hasPendingContent", () => {
  it("is true when any supervisor has something pending", async () => {
    const hooks = composeSupervisors(() => [
      { hasPendingContent: () => Promise.resolve(false) },
      {},
      { hasPendingContent: () => Promise.resolve(true) },
    ]);
    expect(await hooks.hasPendingContent?.()).toBe(true);
  });
  it("is false when no supervisor answers", async () => {
    const hooks = composeSupervisors(() => [
      {},
      { hasPendingContent: () => Promise.resolve(false) },
    ]);
    expect(await hooks.hasPendingContent?.()).toBe(false);
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

describe("SystemInfoSupervisor", () => {
  const systemInfo: SystemInfo = {
    timestamp: "now",
    platform: "darwin",
    neovimVersion: "801",
    cwd: "/tmp" as SystemInfo["cwd"],
    git: undefined,
  };
  it("injects once, and again after a reset", async () => {
    const sup = new SystemInfoSupervisor(systemInfo);
    expect((await sup.onBeforeRequest()).type).toBe("inject");
    expect((await sup.onBeforeRequest()).type).toBe("none");
    sup.onReset();
    expect((await sup.onBeforeRequest()).type).toBe("inject");
    expect((await sup.onBeforeRequest()).type).toBe("none");
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
        inputTokenCount: 300000,
        outputTokenCount: 0,
      }),
    ).toEqual({
      type: "suspend",
      reason: { kind: "compact", nextPrompt: "go" },
    });
    expect(
      await sup.onBeforeRequest({
        inputTokenCount: 400000,
        outputTokenCount: 0,
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
        inputTokenCount: 299999,
        outputTokenCount: 0,
      }),
    ).toEqual({ type: "none" });
    expect(
      await sup.onBeforeRequest({
        inputTokenCount: undefined,
        outputTokenCount: 0,
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
        inputTokenCount: 300000,
        outputTokenCount: 0,
      }),
    ).toEqual({
      type: "suspend",
      reason: { kind: "compact", nextPrompt: "go" },
    });
    expect(
      await sup.onBeforeRequest({
        inputTokenCount: 299999,
        outputTokenCount: 0,
      }),
    ).toEqual({ type: "none" });
  });
});
