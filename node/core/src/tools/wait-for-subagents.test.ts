import { describe, it, expect, vi } from "vitest";
import * as WaitForSubagents from "./wait-for-subagents.ts";
import type { ThreadManager } from "../capabilities/thread-manager.ts";
import type { ThreadId } from "../chat-types.ts";
import type { Result } from "../utils/result.ts";
import type { ToolRequestId } from "../tool-types.ts";

function createMockThreadManager(
  results: Record<
    string,
    { status: "ok"; value: string } | { status: "error"; error: string }
  >,
): ThreadManager {
  return {
    spawnThread: vi.fn(),
    waitForThread: vi.fn((threadId: ThreadId) => {
      const result = results[threadId];
      if (!result) {
        throw new Error(`No mock result for thread ${threadId}`);
      }
      return result;
    }),
    yieldResult: vi.fn(),
  };
}

describe("wait-for-subagents unit tests", () => {
  it("waits for all threads and returns combined results", async () => {
    const threadManager = createMockThreadManager({
      "thread-1": { status: "ok", value: "result from thread 1" },
      "thread-2": { status: "ok", value: "result from thread 2" },
    });
    const requestRender = vi.fn();

    const invocation = WaitForSubagents.execute(
      {
        id: "tool_1" as ToolRequestId,
        toolName: "wait_for_subagents" as const,
        input: {
          threadIds: ["thread-1" as ThreadId, "thread-2" as ThreadId],
        },
      },
      { threadManager, requestRender },
    );

    const result = await invocation.promise;
    expect(result.result.status).toBe("ok");
    if (result.result.status === "ok") {
      const text = (result.result.value[0] as { type: "text"; text: string })
        .text;
      expect(text).toContain("All subagents completed");
      expect(text).toContain("result from thread 1");
      expect(text).toContain("result from thread 2");
    }
  });

  it("includes error results for failed threads", async () => {
    const threadManager = createMockThreadManager({
      "thread-1": { status: "ok", value: "success" },
      "thread-2": { status: "error", error: "something went wrong" },
    });
    const requestRender = vi.fn();

    const invocation = WaitForSubagents.execute(
      {
        id: "tool_1" as ToolRequestId,
        toolName: "wait_for_subagents" as const,
        input: {
          threadIds: ["thread-1" as ThreadId, "thread-2" as ThreadId],
        },
      },
      { threadManager, requestRender },
    );

    const result = await invocation.promise;
    expect(result.result.status).toBe("ok");
    if (result.result.status === "ok") {
      const text = (result.result.value[0] as { type: "text"; text: string })
        .text;
      expect(text).toContain("thread-1: success");
      expect(text).toContain("thread-2: ❌ Error: something went wrong");
    }
  });

  it("tracks progress with completedThreadIds", async () => {
    let resolveThread1: (value: Result<string>) => void;
    let resolveThread2: (value: Result<string>) => void;

    const threadManager: ThreadManager = {
      spawnThread: vi.fn(),
      waitForThread: vi.fn((threadId: ThreadId): Promise<Result<string>> => {
        if (threadId === "thread-1") {
          return new Promise((resolve) => {
            resolveThread1 = resolve;
          });
        }
        return new Promise((resolve) => {
          resolveThread2 = resolve;
        });
      }),
      yieldResult: vi.fn(),
    };
    const requestRender = vi.fn();

    const invocation = WaitForSubagents.execute(
      {
        id: "tool_1" as ToolRequestId,
        toolName: "wait_for_subagents" as const,
        input: {
          threadIds: ["thread-1" as ThreadId, "thread-2" as ThreadId],
        },
      },
      { threadManager, requestRender },
    );

    expect(invocation.progress.completedThreadIds).toEqual([]);

    resolveThread1!({ status: "ok", value: "done 1" });
    await vi.waitFor(() => {
      expect(invocation.progress.completedThreadIds).toContain("thread-1");
    });

    resolveThread2!({ status: "ok", value: "done 2" });
    await invocation.promise;

    expect(invocation.progress.completedThreadIds).toEqual([
      "thread-1",
      "thread-2",
    ]);
  });

  it("calls requestRender after each completion", async () => {
    let resolveThread1: (value: Result<string>) => void;
    let resolveThread2: (value: Result<string>) => void;

    const threadManager: ThreadManager = {
      spawnThread: vi.fn(),
      waitForThread: vi.fn((threadId: ThreadId): Promise<Result<string>> => {
        if (threadId === "thread-1") {
          return new Promise((resolve) => {
            resolveThread1 = resolve;
          });
        }
        return new Promise((resolve) => {
          resolveThread2 = resolve;
        });
      }),
      yieldResult: vi.fn(),
    };
    const requestRender = vi.fn();

    const invocation = WaitForSubagents.execute(
      {
        id: "tool_1" as ToolRequestId,
        toolName: "wait_for_subagents" as const,
        input: {
          threadIds: ["thread-1" as ThreadId, "thread-2" as ThreadId],
        },
      },
      { threadManager, requestRender },
    );

    expect(requestRender).not.toHaveBeenCalled();

    resolveThread1!({ status: "ok", value: "done 1" });
    await vi.waitFor(() => {
      expect(requestRender).toHaveBeenCalledTimes(1);
    });

    resolveThread2!({ status: "ok", value: "done 2" });
    await invocation.promise;

    expect(requestRender).toHaveBeenCalledTimes(2);
  });
});
