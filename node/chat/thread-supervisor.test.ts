import { describe, expect, it, vi } from "vitest";

vi.mock("@magenta/core", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@magenta/core")>();
  return {
    ...orig,
    teardownContainer: vi.fn().mockResolvedValue({
      syncedFiles: 5,
    }),
  };
});

import { teardownContainer } from "@magenta/core";
import { DockerSupervisor } from "./thread-supervisor.ts";

describe("DockerSupervisor", () => {
  describe("onEndTurnWithoutYield", () => {
    it("returns send-message for auto-restart", () => {
      const supervisor = new DockerSupervisor(
        "test-container",
        "/workspace",
        "/host/dir",
      );

      const action = supervisor.onEndTurnWithoutYield({
        stopReason: "end_turn",
        lastAssistantMessage: undefined,
      });
      expect(action.type).toBe("send-message");
      if (action.type === "send-message") {
        expect(action.text).toContain("yield_to_parent");
        expect(action.text).toContain("1/5");
      }
    });

    it("stops auto-restarting after max retries", () => {
      const supervisor = new DockerSupervisor(
        "test-container",
        "/workspace",
        "/host/dir",
        { maxRestarts: 2 },
      );

      expect(
        supervisor.onEndTurnWithoutYield({
          stopReason: "end_turn",
          lastAssistantMessage: undefined,
        }).type,
      ).toBe("send-message");
      expect(
        supervisor.onEndTurnWithoutYield({
          stopReason: "end_turn",
          lastAssistantMessage: undefined,
        }).type,
      ).toBe("send-message");
      expect(
        supervisor.onEndTurnWithoutYield({
          stopReason: "end_turn",
          lastAssistantMessage: undefined,
        }).type,
      ).toBe("none");
    });

    it("does not restart when stop reason is aborted", () => {
      const supervisor = new DockerSupervisor(
        "test-container",
        "/workspace",
        "/host/dir",
      );

      const action = supervisor.onEndTurnWithoutYield({
        stopReason: "aborted",
        lastAssistantMessage: undefined,
      });
      expect(action.type).toBe("none");
    });
  });

  describe("onYield", () => {
    it("calls teardownContainer and returns accept", async () => {
      const supervisor = new DockerSupervisor(
        "test-container",
        "/workspace",
        "/host/dir",
      );

      const action = await supervisor.onYield("done");
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
      const supervisor = new DockerSupervisor(
        "test-container",
        "/workspace",
        "/host/dir",
        { onProgress },
      );

      await supervisor.onYield("done");

      expect(teardownContainer).toHaveBeenCalledWith(
        expect.objectContaining({
          onProgress,
        }),
      );
    });

    it("does not pass onProgress when not provided", async () => {
      const supervisor = new DockerSupervisor(
        "test-container",
        "/workspace",
        "/host/dir",
      );

      await supervisor.onYield("done");

      const call = vi.mocked(teardownContainer).mock.calls[0][0];
      expect(call).not.toHaveProperty("onProgress");
    });
  });
});
