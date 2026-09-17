import { describe, expect, it } from "vitest";
import type { NativeMessageIdx } from "./providers/provider-types.ts";
import type { SystemInfo } from "./providers/system-prompt.ts";
import { createAgentWithMock, userInput } from "./test-helpers.ts";
import {
  AutoCompactSupervisor,
  EditedFilesSupervisor,
  type EndTurnContext,
  injectText,
  type RequestContext,
  SystemInfoSupervisor,
  UnsupervisedSupervisor,
} from "./thread-supervisor.ts";
import type { AbsFilePath } from "./utils/files.ts";

const context: RequestContext = {
  status: "pending",
  inputTokenCount: 400000,
  outputTokenCount: 0,
  nativeMessageIdx: 0 as NativeMessageIdx,
};

describe("Thread supervisor arbitration", () => {
  it("applies request injections in supervisor order, ignoring quiet supervisors", async () => {
    const { core, mockClient } = createAgentWithMock({
      chatSupervisors: [
        { onBeforeRequest: () => Promise.resolve(injectText("first")) },
        {},
        { onBeforeRequest: () => Promise.resolve({ type: "none" }) },
        { onBeforeRequest: () => Promise.resolve(injectText("second")) },
      ],
    });

    const turn = core.submit({
      type: "resolved",
      messages: userInput("hello"),
    });
    const stream = await mockClient.awaitStream();
    const texts = core
      .getProviderMessages()
      .flatMap((message) => message.content)
      .filter((block) => block.type === "text")
      .map((block) => block.text);
    expect(texts.indexOf("first")).toBeLessThan(texts.indexOf("second"));
    expect(texts).toContain("first");
    expect(texts).toContain("second");
    stream.finishResponse("end_turn");
    await turn;
  });

  it("asks pending-content supervisors before issuing a content-only request", async () => {
    const { core, mockClient } = createAgentWithMock({
      chatSupervisors: [
        { hasPendingContent: () => Promise.resolve(false) },
        {},
        {
          hasPendingContent: () => Promise.resolve(true),
          onBeforeRequest: () => Promise.resolve(injectText("pending note")),
        },
      ],
    });

    const turn = core.submit({ type: "resolved", messages: [] });
    const stream = await mockClient.awaitStream();
    expect(JSON.stringify(stream.messages)).toContain("pending note");
    stream.finishResponse("end_turn");
    await turn;
  });

  it("issues no request when no supervisor has pending content", async () => {
    const { core, mockClient } = createAgentWithMock({
      chatSupervisors: [
        {},
        { hasPendingContent: () => Promise.resolve(false) },
      ],
      threadType: "compact",
    });

    expect(await core.submit({ type: "resolved", messages: [] })).toEqual({
      type: "empty",
    });
    expect(mockClient.streams).toHaveLength(0);
  });

  it("lets the first suspension win over an end-turn nudge and later suspension", async () => {
    const { core, mockClient } = createAgentWithMock({
      chatSupervisors: [
        {
          onEndTurnWithoutYield: () => ({
            type: "send-message",
            text: "keep going",
          }),
        },
        {
          onEndTurnWithoutYield: () => ({
            type: "suspend",
            reason: { kind: "stop", message: "first" },
          }),
        },
        {
          onEndTurnWithoutYield: () => {
            observed.push("last");
            return {
              type: "suspend",
              reason: { kind: "stop", message: "second" },
            };
          },
        },
      ],
    });
    const observed: string[] = [];

    const turn = core.submit({
      type: "resolved",
      messages: userInput("hello"),
    });
    const stream = await mockClient.awaitStream();
    stream.finishResponse("end_turn");
    expect(await turn).toEqual({
      type: "empty",
    });
    expect(core.loopState).toMatchObject({
      type: "idle",
      lastResult: {
        type: "suspended",
        reason: { kind: "stop", message: "first" },
      },
    });
    expect(observed).toEqual(["last"]);
    expect(mockClient.streams).toHaveLength(1);
  });
});

describe("EditedFilesSupervisor", () => {
  const idx = (value: number) => value as NativeMessageIdx;
  const apply = (
    supervisor: EditedFilesSupervisor,
    at: number,
    previousContent: string,
    content: string,
    path = "/tmp/a.txt",
  ) =>
    supervisor.onToolApplied({
      absFilePath: path as AbsFilePath,
      nativeMessageIdx: idx(at),
      fileTypeInfo: {
        category: "text",
        mimeType: "text/plain",
        extension: "txt",
      },
      tool: { type: "edl-edit", previousContent, content },
    });

  it("truncates edits inside a group and drops groups after the clone point", () => {
    const source = EditedFilesSupervisor.create();
    source.onAgentLoopStart(idx(0));
    apply(source, 2, "original", "first");
    apply(source, 4, "first", "second");
    apply(source, 4, "other", "changed", "/tmp/b.txt");
    source.onAgentLoopStop(idx(5));
    source.onAgentLoopStart(idx(6));
    apply(source, 8, "second", "third");
    source.onAgentLoopStop(idx(9));
    const clone = EditedFilesSupervisor.clone({
      source,
      nativeMessageIdx: idx(2),
    });
    expect(clone.groups).toEqual([
      {
        id: source.groups[0].id,
        startNativeMessageIdx: 0,
        endNativeMessageIdx: 2,
        files: [{ path: "/tmp/a.txt", snapshot: "original", content: "first" }],
      },
    ]);
    const beforeEdits = EditedFilesSupervisor.clone({
      source,
      nativeMessageIdx: idx(1),
    });
    expect(beforeEdits.groups[0].files).toEqual([]);
    const atEnd = EditedFilesSupervisor.clone({
      source,
      nativeMessageIdx: idx(5),
    });
    expect(atEnd.groups).toEqual([source.groups[0]]);
    clone.onAgentLoopStart(idx(3));
    apply(clone, 5, "first", "fork");
    clone.onAgentLoopStop(idx(6));
    expect(new Set(clone.groups.map((group) => group.id)).size).toBe(2);
    expect(source.groups[0].files[0].content).toBe("second");
    expect(source.groups[1].files[0].content).toBe("third");
    expect(clone.groups[0].files[0].content).toBe("first");
  });

  it("returns detached views and freezes an active source group at the clone boundary", () => {
    const source = EditedFilesSupervisor.create();
    apply(source, 0, "ignored", "outside loop");
    expect(source.groups).toEqual([]);
    source.onAgentLoopStart(idx(1));
    apply(source, 2, "original", "first");
    const clone = EditedFilesSupervisor.clone({
      source,
      nativeMessageIdx: idx(2),
    });
    const view = clone.groups;
    view[0].files[0].content = "mutated";
    view[0].files.push({
      path: "/tmp/b.txt" as AbsFilePath,
      snapshot: "",
      content: "injected",
    });
    view.pop();
    apply(source, 4, "first", "second");
    source.onAgentLoopStop(idx(5));
    apply(source, 6, "second", "ignored after stop");
    clone.onAgentLoopStop(idx(10));
    expect(clone.groups[0]).toMatchObject({
      endNativeMessageIdx: 2,
      files: [{ path: "/tmp/a.txt", snapshot: "original", content: "first" }],
    });
    expect(source.groups[0]).toMatchObject({
      endNativeMessageIdx: 5,
      files: [{ path: "/tmp/a.txt", snapshot: "original", content: "second" }],
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
  it("injects once", async () => {
    const sup = SystemInfoSupervisor.create({
      systemInfo,
      alreadyInjected: false,
    });
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
