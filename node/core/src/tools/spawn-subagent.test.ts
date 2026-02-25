import { describe, it, expect, vi } from "vitest";
import * as SpawnSubagent from "./spawn-subagent.ts";
import type { ThreadManager } from "../capabilities/thread-manager.ts";
import type { ThreadId } from "../chat-types.ts";
import type { ToolRequestId } from "../tool-types.ts";
import type { ProviderToolResult } from "../providers/provider-types.ts";

function createMockThreadManager(
  overrides: Partial<ThreadManager> = {},
): ThreadManager {
  return {
    spawnThread: vi.fn().mockResolvedValue("thread-1" as ThreadId),
    waitForThread: vi.fn().mockResolvedValue({ status: "ok", value: "done" }),
    yieldResult: vi.fn(),
    ...overrides,
  };
}

function makeRequest(input: SpawnSubagent.Input): SpawnSubagent.ToolRequest {
  return {
    id: "tool_1" as ToolRequestId,
    toolName: "spawn_subagent" as const,
    input,
  };
}

async function getResultText(invocation: {
  promise: Promise<ProviderToolResult>;
}): Promise<string> {
  const result = await invocation.promise;
  if (result.result.status === "ok") {
    return (result.result.value[0] as { type: "text"; text: string }).text;
  }
  return result.result.error;
}

describe("spawn-subagent unit tests", () => {
  it("non-blocking returns immediately with threadId", async () => {
    const threadManager = createMockThreadManager();
    const invocation = SpawnSubagent.execute(
      makeRequest({ prompt: "do something", blocking: false }),
      {
        threadManager,
        threadId: "parent-1" as ThreadId,
        requestRender: vi.fn(),
      },
    );

    const text = await getResultText(invocation);
    expect(text).toContain("Sub-agent started with threadId: thread-1");
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(threadManager.waitForThread).not.toHaveBeenCalled();
  });

  it("blocking waits for completion and returns result", async () => {
    const threadManager = createMockThreadManager({
      waitForThread: vi.fn().mockResolvedValue({
        status: "ok",
        value: "the answer",
      }),
    });

    const invocation = SpawnSubagent.execute(
      makeRequest({ prompt: "do something", blocking: true }),
      {
        threadManager,
        threadId: "parent-1" as ThreadId,
        requestRender: vi.fn(),
      },
    );

    const text = await getResultText(invocation);
    expect(text).toContain("completed");
    expect(text).toContain("the answer");
  });

  it("blocking returns error when thread fails", async () => {
    const threadManager = createMockThreadManager({
      waitForThread: vi.fn().mockResolvedValue({
        status: "error",
        error: "crashed",
      }),
    });

    const invocation = SpawnSubagent.execute(
      makeRequest({ prompt: "do something", blocking: true }),
      {
        threadManager,
        threadId: "parent-1" as ThreadId,
        requestRender: vi.fn(),
      },
    );

    const result = await invocation.promise;
    expect(result.result.status).toBe("error");
    if (result.result.status === "error") {
      expect(result.result.error).toContain("failed");
      expect(result.result.error).toContain("crashed");
    }
  });

  it("sets progress.threadId after spawn", async () => {
    const threadManager = createMockThreadManager();
    const invocation = SpawnSubagent.execute(
      makeRequest({ prompt: "do something", blocking: false }),
      {
        threadManager,
        threadId: "parent-1" as ThreadId,
        requestRender: vi.fn(),
      },
    );

    await invocation.promise;
    expect(invocation.progress.threadId).toBe("thread-1");
  });

  it("returns error when spawnThread throws", async () => {
    const threadManager = createMockThreadManager({
      spawnThread: vi.fn().mockRejectedValue(new Error("spawn failed")),
    });

    const invocation = SpawnSubagent.execute(
      makeRequest({ prompt: "do something" }),
      {
        threadManager,
        threadId: "parent-1" as ThreadId,
        requestRender: vi.fn(),
      },
    );

    const result = await invocation.promise;
    expect(result.result.status).toBe("error");
    if (result.result.status === "error") {
      expect(result.result.error).toContain("spawn failed");
    }
  });

  it("maps agentType to correct threadType", async () => {
    const cases: Array<{
      agentType: SpawnSubagent.Input["agentType"];
      expectedThreadType: string;
    }> = [
      { agentType: "fast", expectedThreadType: "subagent_fast" },
      { agentType: "explore", expectedThreadType: "subagent_explore" },
      { agentType: undefined, expectedThreadType: "subagent_default" },
    ];

    for (const { agentType, expectedThreadType } of cases) {
      const threadManager = createMockThreadManager();
      SpawnSubagent.execute(
        makeRequest({ prompt: "do something", agentType, blocking: false }),
        {
          threadManager,
          threadId: "parent-1" as ThreadId,
          requestRender: vi.fn(),
        },
      );

      await vi.waitFor(() => {
        // eslint-disable-next-line @typescript-eslint/unbound-method
        expect(threadManager.spawnThread).toHaveBeenCalled();
      });

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(threadManager.spawnThread).toHaveBeenCalledWith(
        expect.objectContaining({ threadType: expectedThreadType }),
      );
    }
  });
});
