import { describe, expect, it } from "vitest";
import type { NativeMessageIdx } from "./providers/provider-types.ts";
import type { SystemInfo } from "./providers/system-prompt.ts";
import {
  AutoCompactSupervisor,
  composeSupervisors,
  type EndTurnContext,
  injectText,
  type RequestContext,
  SystemInfoSupervisor,
  type ThreadSupervisor,
  UnsupervisedSupervisor,
} from "./thread-supervisor.ts";

const context: RequestContext = {
  status: "pending",
  inputTokenCount: 400000,
  outputTokenCount: 0,
  nativeMessageIdx: 0 as NativeMessageIdx,
};

const requestContext = {
  ...context,
  status: "pending" as const,
};
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
      AutoCompactSupervisor.create({ threshold: 300000, nextPrompt: "go" }),
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
    nativeMessageIdx: 0 as NativeMessageIdx,
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
      AutoCompactSupervisor.create({ threshold: 300000, nextPrompt: "go" }),
    ]);
    expect(hooks.onEndTurn?.(endTurnContext)).toEqual({
      type: "suspend",
      reason: { kind: "compact", nextPrompt: "go" },
    });
  });

  it("keeps only the first suspension", () => {
    const hooks = composeSupervisors(() => [
      AutoCompactSupervisor.create({ threshold: 300000, nextPrompt: "go" }),
      AutoCompactSupervisor.create({ threshold: 300000, nextPrompt: "stop" }),
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
    const sup = SystemInfoSupervisor.create({
      systemInfo,
      alreadyInjected: false,
    });
    expect((await sup.onBeforeRequest(context)).type).toBe("inject");
    expect((await sup.onBeforeRequest(context)).type).toBe("none");
    sup.onReset();
    expect((await sup.onBeforeRequest(context)).type).toBe("inject");
    expect((await sup.onBeforeRequest(context)).type).toBe("none");
  });

  it("restores whether the preamble existed at the clone point", async () => {
    const source = SystemInfoSupervisor.create({
      systemInfo,
      alreadyInjected: false,
    });
    await source.onBeforeRequest({
      ...context,
      nativeMessageIdx: 2 as NativeMessageIdx,
    });
    const before = SystemInfoSupervisor.clone({
      source,
      nativeMessageIdx: 1 as NativeMessageIdx,
    });
    const through = SystemInfoSupervisor.clone({
      source,
      nativeMessageIdx: 2 as NativeMessageIdx,
    });
    expect((await before.onBeforeRequest(context)).type).toBe("inject");
    expect((await through.onBeforeRequest(context)).type).toBe("none");
  });
});

describe("UnsupervisedSupervisor", () => {
  it("clones the restart count and configuration independently", () => {
    const source = UnsupervisedSupervisor.create({ maxRestarts: 2 });
    const endTurnContext: EndTurnContext = {
      stopReason: "end_turn",
      inputTokenCount: undefined,
      lastAssistantMessage: undefined,
      nativeMessageIdx: 0 as NativeMessageIdx,
    };

    expect(source.onEndTurnWithoutYield(endTurnContext)).toMatchObject({
      type: "send-message",
      text: expect.stringContaining("1/2"),
    });

    const clone = UnsupervisedSupervisor.clone({ source });
    expect(clone.onEndTurnWithoutYield(endTurnContext)).toMatchObject({
      type: "send-message",
      text: expect.stringContaining("2/2"),
    });
    expect(source.onEndTurnWithoutYield(endTurnContext)).toMatchObject({
      type: "send-message",
      text: expect.stringContaining("2/2"),
    });
    expect(clone.onEndTurnWithoutYield(endTurnContext)).toEqual({
      type: "none",
    });
  });
});

describe("AutoCompactSupervisor", () => {
  it("clones the configured threshold and continuation prompt", async () => {
    const source = AutoCompactSupervisor.create({
      threshold: 123456,
      nextPrompt: "continue after compacting",
    });
    const clone = AutoCompactSupervisor.clone({ source });
    const context = (inputTokenCount: number) => ({
      status: "pending" as const,
      inputTokenCount,
      outputTokenCount: 0,
      nativeMessageIdx: 0 as NativeMessageIdx,
    });

    expect(await clone.onBeforeRequest(context(123455))).toEqual({
      type: "none",
    });
    expect(await clone.onBeforeRequest(context(123456))).toEqual({
      type: "suspend",
      reason: {
        kind: "compact",
        nextPrompt: "continue after compacting",
      },
    });
  });

  it("suspends for compaction at or over the threshold", async () => {
    const sup = AutoCompactSupervisor.create({
      threshold: 300000,
      nextPrompt: "go",
    });
    expect(
      await sup.onBeforeRequest({
        status: "pending",
        inputTokenCount: 300000,
        outputTokenCount: 0,
        nativeMessageIdx: 0 as NativeMessageIdx,
      }),
    ).toEqual({
      type: "suspend",
      reason: { kind: "compact", nextPrompt: "go" },
    });
    expect(
      await sup.onBeforeRequest({
        status: "pending",
        inputTokenCount: 400000,
        outputTokenCount: 0,
        nativeMessageIdx: 0 as NativeMessageIdx,
      }),
    ).toEqual({
      type: "suspend",
      reason: { kind: "compact", nextPrompt: "go" },
    });
  });

  it("returns none below the threshold or without a token count", async () => {
    const sup = AutoCompactSupervisor.create({
      threshold: 300000,
      nextPrompt: "go",
    });
    expect(
      await sup.onBeforeRequest({
        status: "pending",
        inputTokenCount: 299999,
        outputTokenCount: 0,
        nativeMessageIdx: 0 as NativeMessageIdx,
      }),
    ).toEqual({ type: "none" });
    expect(
      await sup.onBeforeRequest({
        status: "pending",
        inputTokenCount: undefined,
        outputTokenCount: 0,
        nativeMessageIdx: 0 as NativeMessageIdx,
      }),
    ).toEqual({ type: "none" });
  });

  it("suspends at a resting end turn only over the threshold", () => {
    const sup = AutoCompactSupervisor.create({
      threshold: 300000,
      nextPrompt: "go",
    });
    const at = (inputTokenCount: number | undefined): EndTurnContext => ({
      stopReason: "end_turn",
      inputTokenCount,
      lastAssistantMessage: undefined,
      nativeMessageIdx: 0 as NativeMessageIdx,
    });
    expect(sup.onEndTurnWithoutYield(at(300000))).toEqual({
      type: "suspend",
      reason: { kind: "compact", nextPrompt: "go" },
    });
    expect(sup.onEndTurnWithoutYield(at(299999))).toEqual({ type: "none" });
    expect(sup.onEndTurnWithoutYield(at(undefined))).toEqual({ type: "none" });
  });

  it("defaults the threshold to 300000", async () => {
    const sup = AutoCompactSupervisor.create({ nextPrompt: "go" });
    expect(
      await sup.onBeforeRequest({
        status: "pending",
        inputTokenCount: 300000,
        outputTokenCount: 0,
        nativeMessageIdx: 0 as NativeMessageIdx,
      }),
    ).toEqual({
      type: "suspend",
      reason: { kind: "compact", nextPrompt: "go" },
    });
    expect(
      await sup.onBeforeRequest({
        status: "pending",
        inputTokenCount: 299999,
        outputTokenCount: 0,
        nativeMessageIdx: 0 as NativeMessageIdx,
      }),
    ).toEqual({ type: "none" });
  });
});
