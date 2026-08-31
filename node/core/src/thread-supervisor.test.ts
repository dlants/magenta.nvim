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

const requestContext = { ...context, isOpeningRequest: true, suspended: false };
describe("composeSupervisors onBeforeRequest", () => {
  it("contributes one hook entry per supervisor that answers, in order", async () => {
    const first: ThreadSupervisor = {
      onBeforeRequest: () => Promise.resolve(injectText("first")),
    };
    const quiet: ThreadSupervisor = {
      onBeforeRequest: () => Promise.resolve({ type: "none" as const }),
    };
    const hooks = composeSupervisors(() => [first, {}, quiet]);
    expect(hooks.onBeforeRequest.length).toBe(2);
    expect(
      await Promise.all(
        hooks.onBeforeRequest.map((h) => h.run(requestContext)),
      ),
    ).toEqual([injectText("first"), { type: "none" }]);
  });
  it("declares the preflight token count only for supervisors that ask", () => {
    const hooks = composeSupervisors(() => [
      { onBeforeRequest: () => Promise.resolve({ type: "none" as const }) },
      new AutoCompactSupervisor({ threshold: 300000, nextPrompt: "go" }),
    ]);
    expect(
      hooks.onBeforeRequest.map((h) => h.requestPreflightTokenCount ?? false),
    ).toEqual([false, true]);
  });
  it("reads the supervisor list at every call", async () => {
    const supervisors: ThreadSupervisor[] = [];
    const hooks = composeSupervisors(() => supervisors);
    expect(hooks.onBeforeRequest.length).toBe(0);
    supervisors.push({
      onBeforeRequest: () => Promise.resolve(injectText("late")),
    });
    expect(await hooks.onBeforeRequest[0].run(requestContext)).toEqual(
      injectText("late"),
    );
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
    const sup = new SystemInfoSupervisor(systemInfo, {
      alreadyInjected: false,
    });
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
