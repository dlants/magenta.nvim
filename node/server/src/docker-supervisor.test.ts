import { describe, expect, it, vi } from "vitest";
import type { NativeMessageIdx } from "./providers/provider-types.ts";

vi.mock("./container/teardown.ts", () => ({
  teardownContainer: vi.fn().mockResolvedValue({
    syncedFiles: 5,
  }),
}));

import { teardownContainer } from "./container/teardown.ts";
import { DockerSupervisor } from "./docker-supervisor.ts";

describe("DockerSupervisor", () => {
  describe("onToolLoopEnd", () => {
    it("returns send-message for auto-restart", () => {
      const supervisor = DockerSupervisor.create({
        containerName: "test-container",
        workspacePath: "/workspace",
        hostDir: "/host/dir",
      });

      const action = supervisor.onToolLoopEnd({
        stopReason: "end_turn",
        inputTokenCount: undefined,
        lastAssistantMessage: undefined,
        nativeMessageIdx: 0 as NativeMessageIdx,
      });
      expect(action.type).toBe("send-message");
      if (action.type === "send-message") {
        expect(action.text).toContain("yield_to_parent");
        expect(action.text).toContain("1/5");
      }
    });

    it("stops auto-restarting after max retries", () => {
      const supervisor = DockerSupervisor.create({
        containerName: "test-container",
        workspacePath: "/workspace",
        hostDir: "/host/dir",
        maxRestarts: 2,
      });

      expect(
        supervisor.onToolLoopEnd({
          stopReason: "end_turn",
          inputTokenCount: undefined,
          lastAssistantMessage: undefined,
          nativeMessageIdx: 0 as NativeMessageIdx,
        }).type,
      ).toBe("send-message");
      expect(
        supervisor.onToolLoopEnd({
          stopReason: "end_turn",
          inputTokenCount: undefined,
          lastAssistantMessage: undefined,
          nativeMessageIdx: 0 as NativeMessageIdx,
        }).type,
      ).toBe("send-message");
      expect(
        supervisor.onToolLoopEnd({
          stopReason: "end_turn",
          inputTokenCount: undefined,
          lastAssistantMessage: undefined,
          nativeMessageIdx: 0 as NativeMessageIdx,
        }).type,
      ).toBe("none");
    });

    it("does not restart when the turn did not end normally", () => {
      const supervisor = DockerSupervisor.create({
        containerName: "test-container",
        workspacePath: "/workspace",
        hostDir: "/host/dir",
      });

      const action = supervisor.onToolLoopEnd({
        stopReason: "max_tokens",
        inputTokenCount: undefined,
        lastAssistantMessage: undefined,
        nativeMessageIdx: 0 as NativeMessageIdx,
      });
      expect(action.type).toBe("none");
    });
  });

  it("clones restart, teardown, and copied configuration independently", async () => {
    const onProgress = vi.fn();
    const laterOnProgress = vi.fn();
    const factoryArgs = {
      containerName: "test-container",
      workspacePath: "/workspace",
      hostDir: "/host/dir",
      maxRestarts: 2,
      onProgress,
    };
    const source = DockerSupervisor.create(factoryArgs);
    const endTurnContext = {
      stopReason: "end_turn" as const,
      inputTokenCount: undefined,
      lastAssistantMessage: undefined,
      nativeMessageIdx: 0 as NativeMessageIdx,
    };

    factoryArgs.containerName = "mutated-container";
    factoryArgs.workspacePath = "/mutated-workspace";
    factoryArgs.hostDir = "/mutated-host";
    factoryArgs.onProgress = laterOnProgress;

    expect(source.onToolLoopEnd(endTurnContext)).toMatchObject({
      type: "send-message",
      text: expect.stringContaining("1/2"),
    });
    vi.mocked(teardownContainer).mockResolvedValueOnce({ syncedFiles: 5 });
    await source.onYield({ result: "source done" });

    const clone = DockerSupervisor.clone({ source });
    expect(clone.teardownResult).toEqual({ syncedFiles: 5 });
    expect(clone.teardownResult).not.toBe(source.teardownResult);

    expect(source.onToolLoopEnd(endTurnContext)).toMatchObject({
      type: "send-message",
      text: expect.stringContaining("2/2"),
    });
    expect(clone.onToolLoopEnd(endTurnContext)).toMatchObject({
      type: "send-message",
      text: expect.stringContaining("2/2"),
    });
    expect(source.onToolLoopEnd(endTurnContext)).toEqual({
      type: "none",
    });
    expect(clone.onToolLoopEnd(endTurnContext)).toEqual({
      type: "none",
    });

    vi.mocked(teardownContainer).mockResolvedValueOnce({ syncedFiles: 9 });
    const action = await clone.onYield({ result: "clone done" });
    expect(action).toEqual({
      type: "accept",
      resultPrefix: "[Changes synced to /host/dir]",
    });
    expect(teardownContainer).toHaveBeenLastCalledWith({
      containerName: "test-container",
      workspacePath: "/workspace",
      hostDir: "/host/dir",
      onProgress,
    });
    expect(clone.teardownResult).toEqual({ syncedFiles: 9 });
    expect(source.teardownResult).toEqual({ syncedFiles: 5 });
  });

  describe("onYield", () => {
    it("calls teardownContainer and returns accept", async () => {
      const supervisor = DockerSupervisor.create({
        containerName: "test-container",
        workspacePath: "/workspace",
        hostDir: "/host/dir",
      });

      const action = await supervisor.onYield({ result: "done" });
      expect(action.type).toBe("accept");
      if (action.type === "accept") {
        expect(action.resultPrefix).toContain("/host/dir");
      }
      expect(teardownContainer).toHaveBeenCalledWith(
        expect.objectContaining({
          containerName: "test-container",
          workspacePath: "/workspace",
          hostDir: "/host/dir",
        }),
      );
    });

    it("forwards onProgress to teardownContainer", async () => {
      const onProgress = vi.fn();
      const supervisor = DockerSupervisor.create({
        containerName: "test-container",
        workspacePath: "/workspace",
        hostDir: "/host/dir",
        onProgress,
      });

      await supervisor.onYield({ result: "done" });

      expect(teardownContainer).toHaveBeenCalledWith(
        expect.objectContaining({
          onProgress,
        }),
      );
    });

    it("does not pass onProgress when not provided", async () => {
      const supervisor = DockerSupervisor.create({
        containerName: "test-container",
        workspacePath: "/workspace",
        hostDir: "/host/dir",
      });

      await supervisor.onYield({ result: "done" });

      const call = vi.mocked(teardownContainer).mock.lastCall?.[0];
      expect(call).not.toHaveProperty("onProgress");
    });
  });
});
