import { describe, it, expect, vi } from "vitest";
import * as SpawnForeach from "./spawn-foreach.ts";
import type { ForEachElement } from "./spawn-foreach.ts";
import type { ThreadManager } from "../capabilities/thread-manager.ts";
import type { ThreadId } from "../chat-types.ts";
import type { ToolRequestId } from "../tool-types.ts";
import type { Result } from "../utils/result.ts";
import type { UnresolvedFilePath } from "../utils/files.ts";

function createMockThreadManager(opts?: {
  spawnThread?: ThreadManager["spawnThread"];
  waitForThread?: ThreadManager["waitForThread"];
}): ThreadManager {
  return {
    spawnThread:
      opts?.spawnThread ?? vi.fn(() => Promise.resolve("thread_1" as ThreadId)),
    waitForThread:
      opts?.waitForThread ??
      vi.fn(() => Promise.resolve({ status: "ok" as const, value: "done" })),
    yieldResult: vi.fn(),
  };
}

function makeRequest(input: {
  prompt: string;
  elements: string[];
  contextFiles?: UnresolvedFilePath[];
  agentType?: SpawnForeach.Input["agentType"];
}): SpawnForeach.ToolRequest {
  return {
    id: "tool_1" as ToolRequestId,
    toolName: "spawn_foreach" as const,
    input: {
      prompt: input.prompt,
      elements: input.elements.map((e) => e as ForEachElement),
      contextFiles: input.contextFiles,
      agentType: input.agentType,
    },
  };
}

describe("spawn-foreach unit tests", () => {
  it("processes all elements and returns summary", async () => {
    let callCount = 0;
    const threadManager = createMockThreadManager({
      spawnThread: vi.fn(() => {
        callCount++;
        return Promise.resolve(`thread_${callCount}` as ThreadId);
      }),
      waitForThread: vi.fn(() =>
        Promise.resolve({
          status: "ok" as const,
          value: "element completed",
        }),
      ),
    });

    const invocation = SpawnForeach.execute(
      makeRequest({
        prompt: "fix this",
        elements: ["elem1", "elem2"],
      }),
      {
        threadManager,
        threadId: "parent_thread" as ThreadId,
        maxConcurrentSubagents: 10,
        requestRender: vi.fn(),
      },
    );

    const result = await invocation.promise;
    expect(result.result.status).toBe("ok");
    if (result.result.status === "ok") {
      const text = (result.result.value[0] as { type: "text"; text: string })
        .text;
      expect(text).toContain("Total elements: 2");
      expect(text).toContain("Successful: 2");
      expect(text).toContain("Failed: 0");
    }
  });

  it("handles element errors and continues", async () => {
    let callCount = 0;
    const threadManager = createMockThreadManager({
      spawnThread: vi.fn(() => {
        callCount++;
        return Promise.resolve(`thread_${callCount}` as ThreadId);
      }),
      waitForThread: vi.fn((threadId: ThreadId) => {
        if (threadId === ("thread_1" as ThreadId)) {
          return Promise.resolve({
            status: "error" as const,
            error: "something broke",
          });
        }
        return Promise.resolve({ status: "ok" as const, value: "success" });
      }),
    });

    const invocation = SpawnForeach.execute(
      makeRequest({
        prompt: "fix this",
        elements: ["elem1", "elem2"],
      }),
      {
        threadManager,
        threadId: "parent_thread" as ThreadId,
        maxConcurrentSubagents: 10,
        requestRender: vi.fn(),
      },
    );

    const result = await invocation.promise;
    expect(result.result.status).toBe("ok");
    if (result.result.status === "ok") {
      const text = (result.result.value[0] as { type: "text"; text: string })
        .text;
      expect(text).toContain("Successful: 1");
      expect(text).toContain("Failed: 1");
    }
  });

  it("abort stops processing", async () => {
    const spawnDeferreds: Array<{
      resolve: (value: ThreadId) => void;
    }> = [];
    const waitDeferreds = new Map<
      string,
      { resolve: (value: Result<string>) => void }
    >();

    const threadManager = createMockThreadManager({
      spawnThread: vi.fn(
        () =>
          new Promise<ThreadId>((resolve) => {
            spawnDeferreds.push({ resolve });
          }),
      ),
      waitForThread: vi.fn(
        (threadId: ThreadId) =>
          new Promise<Result<string>>((resolve) => {
            waitDeferreds.set(threadId as string, { resolve });
          }),
      ),
    });

    const invocation = SpawnForeach.execute(
      makeRequest({
        prompt: "fix this",
        elements: ["elem1", "elem2"],
      }),
      {
        threadManager,
        threadId: "parent_thread" as ThreadId,
        maxConcurrentSubagents: 10,
        requestRender: vi.fn(),
      },
    );

    // Wait for both spawn calls to be made
    await vi.waitFor(() => expect(spawnDeferreds.length).toBe(2));

    // Abort before resolving
    invocation.abort();

    // Resolve the spawns so processElement can finish
    spawnDeferreds[0].resolve("thread_1" as ThreadId);
    spawnDeferreds[1].resolve("thread_2" as ThreadId);

    // Resolve the waits so processElement completes
    await vi.waitFor(() => expect(waitDeferreds.has("thread_1")).toBe(true));
    waitDeferreds.get("thread_1")!.resolve({ status: "ok", value: "done" });
    await vi.waitFor(() => expect(waitDeferreds.has("thread_2")).toBe(true));
    waitDeferreds.get("thread_2")!.resolve({ status: "ok", value: "done" });

    const result = await invocation.promise;
    expect(result.result.status).toBe("error");
    if (result.result.status === "error") {
      expect(result.result.error).toContain("aborted");
    }
  });

  it("validation rejects empty elements array", () => {
    const result = SpawnForeach.validateInput({
      prompt: "test",
      elements: [],
    });
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error).toContain("empty");
    }
  });

  it("respects maxConcurrentSubagents", async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    const deferreds: Array<{
      resolve: (value: ThreadId) => void;
    }> = [];

    const waitDeferreds = new Map<
      string,
      { resolve: (value: Result<string>) => void }
    >();

    const threadManager = createMockThreadManager({
      spawnThread: vi.fn(() => {
        concurrent++;
        if (concurrent > maxConcurrent) {
          maxConcurrent = concurrent;
        }
        return new Promise<ThreadId>((resolve) => {
          deferreds.push({ resolve });
        });
      }),
      waitForThread: vi.fn(
        (threadId: ThreadId) =>
          new Promise<Result<string>>((resolve) => {
            waitDeferreds.set(threadId as string, { resolve });
          }),
      ),
    });

    const invocation = SpawnForeach.execute(
      makeRequest({
        prompt: "fix this",
        elements: ["elem1", "elem2", "elem3"],
      }),
      {
        threadManager,
        threadId: "parent_thread" as ThreadId,
        maxConcurrentSubagents: 2,
        requestRender: vi.fn(),
      },
    );

    // Wait for the first 2 spawn calls to be made
    await vi.waitFor(() => expect(deferreds.length).toBe(2));

    // Only 2 should be in flight since maxConcurrent=2
    expect(maxConcurrent).toBe(2);

    // Resolve first spawn, then its wait
    concurrent--;
    deferreds[0].resolve("thread_1" as ThreadId);

    await vi.waitFor(() => expect(waitDeferreds.has("thread_1")).toBe(true));
    waitDeferreds.get("thread_1")!.resolve({ status: "ok", value: "done1" });

    // Now the 3rd element should start
    await vi.waitFor(() => expect(deferreds.length).toBe(3));

    // Resolve remaining
    concurrent--;
    deferreds[1].resolve("thread_2" as ThreadId);
    await vi.waitFor(() => expect(waitDeferreds.has("thread_2")).toBe(true));
    waitDeferreds.get("thread_2")!.resolve({ status: "ok", value: "done2" });

    concurrent--;
    deferreds[2].resolve("thread_3" as ThreadId);
    await vi.waitFor(() => expect(waitDeferreds.has("thread_3")).toBe(true));
    waitDeferreds.get("thread_3")!.resolve({ status: "ok", value: "done3" });

    const result = await invocation.promise;
    expect(result.result.status).toBe("ok");
    // Max concurrent should never exceed 2
    expect(maxConcurrent).toBe(2);
  });

  it("passes contextFiles to spawnThread", async () => {
    const spawnThread = vi.fn(() => Promise.resolve("thread_1" as ThreadId));
    const threadManager = createMockThreadManager({
      spawnThread,
      waitForThread: vi.fn(() =>
        Promise.resolve({
          status: "ok" as const,
          value: "done",
        }),
      ),
    });

    const invocation = SpawnForeach.execute(
      makeRequest({
        prompt: "fix this",
        elements: ["elem1"],
        contextFiles: ["/some/file.ts" as UnresolvedFilePath],
      }),
      {
        threadManager,
        threadId: "parent_thread" as ThreadId,
        maxConcurrentSubagents: 10,
        requestRender: vi.fn(),
      },
    );

    await invocation.promise;

    expect(spawnThread).toHaveBeenCalledTimes(1);
    expect(spawnThread).toHaveBeenCalledWith(
      expect.objectContaining({
        contextFiles: ["/some/file.ts"],
      }),
    );
  });
});
