import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadManager } from "../capabilities/thread-manager.ts";
import type { ThreadId } from "../chat-types.ts";
import type { ProvisionResult } from "../container/types.ts";
import type { ProviderToolResult } from "../providers/provider-types.ts";
import type { ToolRequestId } from "../tool-types.ts";
import type { NvimCwd, UnresolvedFilePath } from "../utils/files.ts";
import type { Result } from "../utils/result.ts";

vi.mock("../container/provision.ts", () => ({
  provisionContainer: vi.fn().mockResolvedValue({
    containerName: "magenta-test-abc123",
    imageName: "magenta-dev-test",
  } satisfies ProvisionResult),
}));

import { provisionContainer } from "../container/provision.ts";
import * as SpawnSubagents from "./spawn-subagents.ts";

type MockThreadManager = ThreadManager & {
  simulateYield(threadId: ThreadId, result: Result<string>): void;
};

function createMockThreadManager(
  overrides: Partial<ThreadManager> = {},
): MockThreadManager {
  const results = new Map<string, { status: "done"; result: Result<string> }>();
  const callbacks = new Map<string, Array<() => void>>();

  const manager: MockThreadManager = {
    spawnThread: vi.fn().mockResolvedValue("thread-1" as ThreadId),
    onThreadYielded: vi.fn((threadId: ThreadId, callback: () => void) => {
      let cbs = callbacks.get(threadId);
      if (!cbs) {
        cbs = [];
        callbacks.set(threadId, cbs);
      }
      cbs.push(callback);
      // If already yielded, fire immediately
      if (results.has(threadId)) {
        callback();
      }
    }),
    getThreadResult: vi.fn((threadId: ThreadId) => {
      return results.get(threadId) ?? { status: "pending" as const };
    }),
    simulateYield(threadId: ThreadId, result: Result<string>) {
      results.set(threadId, { status: "done", result });
      const cbs = callbacks.get(threadId);
      if (cbs) {
        for (const cb of cbs) {
          cb();
        }
      }
    },
    ...overrides,
  };
  return manager;
}

function makeRequest(input: SpawnSubagents.Input): SpawnSubagents.ToolRequest {
  return {
    id: "tool_1" as ToolRequestId,
    toolName: "spawn_subagents" as const,
    input,
  };
}

async function getResultText(invocation: {
  promise: Promise<ProviderToolResult>;
}): Promise<string> {
  const { result } = await invocation.promise;
  if (result.status === "ok") {
    return (result.value[0] as { type: "text"; text: string }).text;
  }
  return result.error;
}

describe("spawn-subagents unit tests", () => {
  it("single agent blocks and returns result", async () => {
    const threadManager = createMockThreadManager();

    const invocation = SpawnSubagents.execute(
      makeRequest({ agents: [{ prompt: "do something" }] }),
      {
        threadManager,
        threadId: "parent-1" as ThreadId,
        maxConcurrentSubagents: 10,
        maxConcurrentFastSubagents: 10,
        requestRender: vi.fn(),
        cwd: "/test" as NvimCwd,
        agents: {},
      },
    );

    // Wait for spawn, then simulate yield
    await vi.waitFor(() => {
      expect(threadManager.spawnThread).toHaveBeenCalled();
    });
    threadManager.simulateYield("thread-1" as ThreadId, {
      status: "ok",
      value: "the answer",
    });

    const text = await getResultText(invocation);
    expect(text).toContain("the answer");
  });

  it("single agent returns error when thread fails", async () => {
    const threadManager = createMockThreadManager();

    const invocation = SpawnSubagents.execute(
      makeRequest({ agents: [{ prompt: "do something" }] }),
      {
        threadManager,
        threadId: "parent-1" as ThreadId,
        maxConcurrentSubagents: 10,
        maxConcurrentFastSubagents: 10,
        requestRender: vi.fn(),
        cwd: "/test" as NvimCwd,
        agents: {},
      },
    );

    await vi.waitFor(() => {
      expect(threadManager.spawnThread).toHaveBeenCalled();
    });
    threadManager.simulateYield("thread-1" as ThreadId, {
      status: "error",
      error: "crashed",
    });

    const text = await getResultText(invocation);
    expect(text).toContain("crashed");
    expect(text).toContain("Failed: 1");
  });

  it("sets progress.threadId after spawn", async () => {
    const threadManager = createMockThreadManager();
    const invocation = SpawnSubagents.execute(
      makeRequest({ agents: [{ prompt: "do something" }] }),
      {
        threadManager,
        threadId: "parent-1" as ThreadId,
        maxConcurrentSubagents: 10,
        maxConcurrentFastSubagents: 10,
        requestRender: vi.fn(),
        cwd: "/test" as NvimCwd,
        agents: {},
      },
    );

    await vi.waitFor(() => {
      expect(threadManager.spawnThread).toHaveBeenCalled();
    });

    const state = invocation.progress.elements[0].state;
    expect(state.status).toBe("spawned");
    if (state.status === "spawned") {
      expect(state.threadId).toBe("thread-1");
    }

    threadManager.simulateYield("thread-1" as ThreadId, {
      status: "ok",
      value: "done",
    });
    await invocation.promise;
  });

  it("returns error when spawnThread throws", async () => {
    const threadManager = createMockThreadManager({
      spawnThread: vi.fn().mockRejectedValue(new Error("spawn failed")),
    });

    const invocation = SpawnSubagents.execute(
      makeRequest({ agents: [{ prompt: "do something" }] }),
      {
        threadManager,
        threadId: "parent-1" as ThreadId,
        maxConcurrentSubagents: 10,
        maxConcurrentFastSubagents: 10,
        requestRender: vi.fn(),
        cwd: "/test" as NvimCwd,
        agents: {},
      },
    );

    const text = await getResultText(invocation);
    expect(text).toContain("spawn failed");
  });

  it("maps agentType to correct threadType", async () => {
    const cases: Array<{
      agentType: SpawnSubagents.SubagentEntry["agentType"];
      expectedThreadType: string;
    }> = [
      { agentType: "fast-edit", expectedThreadType: "subagent" },
      { agentType: "explore", expectedThreadType: "subagent" },
      { agentType: undefined, expectedThreadType: "subagent" },
    ];

    for (const { agentType, expectedThreadType } of cases) {
      const threadManager = createMockThreadManager();
      const entry: SpawnSubagents.SubagentEntry = { prompt: "do something" };
      if (agentType !== undefined) {
        entry.agentType = agentType;
      }
      SpawnSubagents.execute(makeRequest({ agents: [entry] }), {
        threadManager,
        threadId: "parent-1" as ThreadId,
        maxConcurrentSubagents: 10,
        maxConcurrentFastSubagents: 10,
        requestRender: vi.fn(),
        cwd: "/test" as NvimCwd,
        agents: {},
      });

      await vi.waitFor(() => {
        expect(threadManager.spawnThread).toHaveBeenCalled();
      });

      expect(threadManager.spawnThread).toHaveBeenCalledWith(
        expect.objectContaining({ threadType: expectedThreadType }),
      );
    }
  });

  it("processes multiple agents in parallel and returns summary", async () => {
    let callCount = 0;
    const threadManager = createMockThreadManager({
      spawnThread: vi.fn(() => {
        callCount++;
        return Promise.resolve(`thread_${callCount}` as ThreadId);
      }),
    });

    const invocation = SpawnSubagents.execute(
      makeRequest({
        agents: [{ prompt: "task 1" }, { prompt: "task 2" }],
      }),
      {
        threadManager,
        threadId: "parent_thread" as ThreadId,
        maxConcurrentSubagents: 10,
        maxConcurrentFastSubagents: 10,
        requestRender: vi.fn(),
        cwd: "/test" as NvimCwd,
        agents: {},
      },
    );

    await vi.waitFor(() => {
      expect(threadManager.spawnThread).toHaveBeenCalledTimes(2);
    });
    threadManager.simulateYield("thread_1" as ThreadId, {
      status: "ok",
      value: "element completed",
    });
    threadManager.simulateYield("thread_2" as ThreadId, {
      status: "ok",
      value: "element completed",
    });

    const text = await getResultText(invocation);
    expect(text).toContain("Total: 2");
    expect(text).toContain("Successful: 2");
    expect(text).toContain("Failed: 0");
  });

  it("handles element errors and continues", async () => {
    let callCount = 0;
    const threadManager = createMockThreadManager({
      spawnThread: vi.fn(() => {
        callCount++;
        return Promise.resolve(`thread_${callCount}` as ThreadId);
      }),
    });

    const invocation = SpawnSubagents.execute(
      makeRequest({
        agents: [{ prompt: "task 1" }, { prompt: "task 2" }],
      }),
      {
        threadManager,
        threadId: "parent_thread" as ThreadId,
        maxConcurrentSubagents: 10,
        maxConcurrentFastSubagents: 10,
        requestRender: vi.fn(),
        cwd: "/test" as NvimCwd,
        agents: {},
      },
    );

    await vi.waitFor(() => {
      expect(threadManager.spawnThread).toHaveBeenCalledTimes(2);
    });
    threadManager.simulateYield("thread_1" as ThreadId, {
      status: "error",
      error: "something broke",
    });
    threadManager.simulateYield("thread_2" as ThreadId, {
      status: "ok",
      value: "success",
    });

    const text = await getResultText(invocation);
    expect(text).toContain("Successful: 1");
    expect(text).toContain("Failed: 1");
  });

  it("respects maxConcurrentSubagents, only launching more once earlier ones yield", async () => {
    let live = 0;
    let maxLive = 0;
    let spawnCount = 0;

    const threadManager = createMockThreadManager({
      spawnThread: vi.fn(() => {
        spawnCount++;
        live++;
        if (live > maxLive) {
          maxLive = live;
        }
        return Promise.resolve(`thread_${spawnCount}` as ThreadId);
      }),
    });

    const invocation = SpawnSubagents.execute(
      makeRequest({
        agents: [
          { prompt: "task 1" },
          { prompt: "task 2" },
          { prompt: "task 3" },
        ],
      }),
      {
        threadManager,
        threadId: "parent_thread" as ThreadId,
        maxConcurrentSubagents: 2,
        maxConcurrentFastSubagents: 10,
        requestRender: vi.fn(),
        cwd: "/test" as NvimCwd,
        agents: {},
      },
    );

    // Only 2 should be spawned (live) at once, since the 3rd should not
    // launch until one of the first two yields.
    await vi.waitFor(() =>
      expect(threadManager.spawnThread).toHaveBeenCalledTimes(2),
    );
    expect(maxLive).toBe(2);

    // Yielding the first frees a slot, allowing the 3rd to spawn
    live--;
    threadManager.simulateYield("thread_1" as ThreadId, {
      status: "ok",
      value: "done1",
    });
    await vi.waitFor(() =>
      expect(threadManager.spawnThread).toHaveBeenCalledTimes(3),
    );
    expect(maxLive).toBe(2);

    threadManager.simulateYield("thread_2" as ThreadId, {
      status: "ok",
      value: "done2",
    });
    threadManager.simulateYield("thread_3" as ThreadId, {
      status: "ok",
      value: "done3",
    });

    const { result } = await invocation.promise;
    expect(result.status).toBe("ok");
    expect(maxLive).toBe(2);
  });

  it("fast and non-fast agents queue independently with separate limits", async () => {
    let live = 0;
    let maxLive = 0;
    let spawnCount = 0;

    const threadManager = createMockThreadManager({
      spawnThread: vi.fn(() => {
        spawnCount++;
        live++;
        if (live > maxLive) {
          maxLive = live;
        }
        return Promise.resolve(`thread_${spawnCount}` as ThreadId);
      }),
    });

    const invocation = SpawnSubagents.execute(
      makeRequest({
        agents: [
          { prompt: "fast 1", agentType: "fast" },
          { prompt: "fast 2", agentType: "fast" },
          { prompt: "other 1" },
          { prompt: "other 2" },
        ],
      }),
      {
        threadManager,
        threadId: "parent_thread" as ThreadId,
        maxConcurrentSubagents: 1,
        maxConcurrentFastSubagents: 1,
        requestRender: vi.fn(),
        cwd: "/test" as NvimCwd,
        agents: {
          fast: {
            name: "fast",
            description: "fast agent",
            systemPrompt: "",
            systemReminder: undefined,
            fastModel: true,
            thinkingModel: undefined,
            effort: undefined,
            tier: "leaf",
          },
        },
      },
    );

    // Each queue has a limit of 1, but since fast and non-fast run in
    // separate queues, up to 2 (1 fast + 1 other) should be live at once.
    await vi.waitFor(() =>
      expect(threadManager.spawnThread).toHaveBeenCalledTimes(2),
    );
    expect(maxLive).toBe(2);

    live -= 2;
    for (let i = 1; i <= 2; i++) {
      threadManager.simulateYield(`thread_${i}` as ThreadId, {
        status: "ok",
        value: `done${i}`,
      });
    }

    await vi.waitFor(() =>
      expect(threadManager.spawnThread).toHaveBeenCalledTimes(4),
    );

    threadManager.simulateYield("thread_3" as ThreadId, {
      status: "ok",
      value: "done3",
    });
    threadManager.simulateYield("thread_4" as ThreadId, {
      status: "ok",
      value: "done4",
    });

    const { result } = await invocation.promise;
    expect(result.status).toBe("ok");
    expect(maxLive).toBe(2);
  });

  it("queue advances to the next element when one errors, not just on success", async () => {
    let live = 0;
    let maxLive = 0;
    let spawnCount = 0;

    const threadManager = createMockThreadManager({
      spawnThread: vi.fn(() => {
        spawnCount++;
        live++;
        if (live > maxLive) {
          maxLive = live;
        }
        return Promise.resolve(`thread_${spawnCount}` as ThreadId);
      }),
    });

    const invocation = SpawnSubagents.execute(
      makeRequest({
        agents: [
          { prompt: "task 1" },
          { prompt: "task 2" },
          { prompt: "task 3" },
        ],
      }),
      {
        threadManager,
        threadId: "parent_thread" as ThreadId,
        maxConcurrentSubagents: 2,
        maxConcurrentFastSubagents: 10,
        requestRender: vi.fn(),
        cwd: "/test" as NvimCwd,
        agents: {},
      },
    );

    await vi.waitFor(() =>
      expect(threadManager.spawnThread).toHaveBeenCalledTimes(2),
    );

    // Erroring out the first element should free its slot just like a
    // successful yield would, allowing the 3rd element to spawn.
    live--;
    threadManager.simulateYield("thread_1" as ThreadId, {
      status: "error",
      error: "crashed",
    });
    await vi.waitFor(() =>
      expect(threadManager.spawnThread).toHaveBeenCalledTimes(3),
    );
    expect(maxLive).toBe(2);

    threadManager.simulateYield("thread_2" as ThreadId, {
      status: "ok",
      value: "done2",
    });
    threadManager.simulateYield("thread_3" as ThreadId, {
      status: "ok",
      value: "done3",
    });

    const { result } = await invocation.promise;
    expect(result.status).toBe("ok");
  });

  it("abort stops processing", async () => {
    const spawnDeferreds: Array<{ resolve: (value: ThreadId) => void }> = [];

    const threadManager = createMockThreadManager({
      spawnThread: vi.fn(
        () =>
          new Promise<ThreadId>((resolve) => {
            spawnDeferreds.push({ resolve });
          }),
      ),
    });

    const invocation = SpawnSubagents.execute(
      makeRequest({
        agents: [{ prompt: "task 1" }, { prompt: "task 2" }],
      }),
      {
        threadManager,
        threadId: "parent_thread" as ThreadId,
        maxConcurrentSubagents: 10,
        maxConcurrentFastSubagents: 10,
        requestRender: vi.fn(),
        cwd: "/test" as NvimCwd,
        agents: {},
      },
    );

    await vi.waitFor(() => expect(spawnDeferreds.length).toBe(2));
    invocation.abort();

    spawnDeferreds[0].resolve("thread_1" as ThreadId);
    spawnDeferreds[1].resolve("thread_2" as ThreadId);

    const { result } = await invocation.promise;
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error).toContain("aborted");
    }
  });

  it("passes contextFiles to spawnThread", async () => {
    const spawnThread = vi.fn(() => Promise.resolve("thread_1" as ThreadId));
    const threadManager = createMockThreadManager({
      spawnThread,
    });

    const invocation = SpawnSubagents.execute(
      makeRequest({
        agents: [
          {
            prompt: "task 1",
            contextFiles: ["/some/file.ts" as UnresolvedFilePath],
          },
        ],
      }),
      {
        threadManager,
        threadId: "parent_thread" as ThreadId,
        maxConcurrentSubagents: 10,
        maxConcurrentFastSubagents: 10,
        requestRender: vi.fn(),
        cwd: "/test" as NvimCwd,
        agents: {},
      },
    );

    await vi.waitFor(() => {
      expect(spawnThread).toHaveBeenCalled();
    });
    threadManager.simulateYield("thread_1" as ThreadId, {
      status: "ok",
      value: "done",
    });

    await invocation.promise;
    expect(spawnThread).toHaveBeenCalledWith(
      expect.objectContaining({
        contextFiles: ["/some/file.ts"],
      }),
    );
  });

  it("passes resolved cwd to spawnThread when directory is provided", async () => {
    const spawnThread = vi.fn(() => Promise.resolve("thread_1" as ThreadId));
    const threadManager = createMockThreadManager({
      spawnThread,
    });

    const invocation = SpawnSubagents.execute(
      makeRequest({
        agents: [
          {
            prompt: "task 1",
            directory: "some/subdir",
          },
        ],
      }),
      {
        threadManager,
        threadId: "parent_thread" as ThreadId,
        maxConcurrentSubagents: 10,
        maxConcurrentFastSubagents: 10,
        requestRender: vi.fn(),
        cwd: "/project/root" as NvimCwd,
        agents: {},
      },
    );

    await vi.waitFor(() => {
      expect(spawnThread).toHaveBeenCalled();
    });
    threadManager.simulateYield("thread_1" as ThreadId, {
      status: "ok",
      value: "done",
    });

    await invocation.promise;
    expect(spawnThread).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: path.resolve("/project/root", "some/subdir"),
      }),
    );
  });

  it("does not pass cwd to spawnThread when directory is not provided", async () => {
    const spawnThread = vi.fn(() => Promise.resolve("thread_1" as ThreadId));
    const threadManager = createMockThreadManager({
      spawnThread,
    });

    const invocation = SpawnSubagents.execute(
      makeRequest({
        agents: [
          {
            prompt: "task 1",
          },
        ],
      }),
      {
        threadManager,
        threadId: "parent_thread" as ThreadId,
        maxConcurrentSubagents: 10,
        maxConcurrentFastSubagents: 10,
        requestRender: vi.fn(),
        cwd: "/project/root" as NvimCwd,
        agents: {},
      },
    );

    await vi.waitFor(() => {
      expect(spawnThread).toHaveBeenCalled();
    });
    threadManager.simulateYield("thread_1" as ThreadId, {
      status: "ok",
      value: "done",
    });

    await invocation.promise;
    expect(spawnThread).toHaveBeenCalledWith(
      expect.not.objectContaining({
        cwd: expect.anything(),
      }),
    );
  });

  it("validation rejects empty agents array", () => {
    const result = SpawnSubagents.validateInput({ agents: [] });
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error).toContain("empty");
    }
  });

  it("validation rejects missing prompt", () => {
    const result = SpawnSubagents.validateInput({
      agents: [{ notPrompt: "test" }],
    });
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error).toContain("prompt");
    }
  });

  it("validation accepts custom agentType strings", () => {
    const result = SpawnSubagents.validateInput({
      agents: [{ prompt: "test", agentType: "my-custom-agent" }],
    });
    expect(result.status).toBe("ok");
  });

  it("validation rejects non-string agentType", () => {
    const result = SpawnSubagents.validateInput({
      agents: [{ prompt: "test", agentType: 123 }],
    });
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error).toContain("agentType");
    }
  });

  it("validation rejects non-array agents", () => {
    const result = SpawnSubagents.validateInput({ agents: "not-an-array" });
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error).toContain("array");
    }
  });

  it("validation rejects non-string contextFiles items", () => {
    const result = SpawnSubagents.validateInput({
      agents: [{ prompt: "test", contextFiles: [123] }],
    });
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error).toContain("contextFiles");
    }
  });

  it("validation rejects non-string directory", () => {
    const result = SpawnSubagents.validateInput({
      agents: [{ prompt: "test", directory: 123 }],
    });
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error).toContain("directory");
    }
  });

  it("abort during Phase 2 (waiting for yields) returns aborted error", async () => {
    const threadManager = createMockThreadManager();

    const invocation = SpawnSubagents.execute(
      makeRequest({ agents: [{ prompt: "do something" }] }),
      {
        threadManager,
        threadId: "parent-1" as ThreadId,
        maxConcurrentSubagents: 10,
        maxConcurrentFastSubagents: 10,
        requestRender: vi.fn(),
        cwd: "/test" as NvimCwd,
        agents: {},
      },
    );

    // Wait for spawn to complete (Phase 1 done)
    await vi.waitFor(() => {
      expect(threadManager.spawnThread).toHaveBeenCalled();
    });

    // Now we're in Phase 2 (waiting for yields). Abort here.
    invocation.abort();

    // Simulate the yield after abort - it should not matter
    threadManager.simulateYield("thread-1" as ThreadId, {
      status: "ok",
      value: "too late",
    });

    const { result } = await invocation.promise;
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error).toContain("aborted");
    }
  });
});

describe("spawn-subagents docker provisioning", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "magenta-spawn-test-"),
    );
    vi.mocked(provisionContainer).mockReset().mockResolvedValue({
      containerName: "magenta-test-abc123",
      imageName: "magenta-dev-test",
    });
  });

  afterEach(async () => {
    if (tempDir) {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("uses inline dockerfile and workspacePath for provisioning", async () => {
    const threadManager = createMockThreadManager();

    const invocation = SpawnSubagents.execute(
      makeRequest({
        agents: [
          {
            prompt: "do docker work",
            environment: "docker",
            directory: tempDir,
            dockerfile: "Dockerfile",
            workspacePath: "/workspace",
          },
        ],
      }),
      {
        threadManager,
        threadId: "parent-1" as ThreadId,
        maxConcurrentSubagents: 10,
        maxConcurrentFastSubagents: 10,
        requestRender: vi.fn(),
        cwd: "/test" as NvimCwd,
        agents: {},
      },
    );

    await vi.waitFor(() => {
      expect(threadManager.spawnThread).toHaveBeenCalled();
    });
    threadManager.simulateYield("thread-1" as ThreadId, {
      status: "ok",
      value: "done",
    });

    await invocation.promise;
    expect(provisionContainer).toHaveBeenCalledWith(
      expect.objectContaining({
        hostDir: tempDir,
        containerConfig: {
          dockerfile: "Dockerfile",
          workspacePath: "/workspace",
        },
      }),
    );
  });

  it("returns error when dockerfile/workspacePath missing for docker env", async () => {
    const threadManager = createMockThreadManager();

    const invocation = SpawnSubagents.execute(
      makeRequest({
        agents: [
          {
            prompt: "do docker work",
            environment: "docker",
            directory: tempDir,
          } as SpawnSubagents.SubagentEntry,
        ],
      }),
      {
        threadManager,
        threadId: "parent-1" as ThreadId,
        maxConcurrentSubagents: 10,
        maxConcurrentFastSubagents: 10,
        requestRender: vi.fn(),
        cwd: "/test" as NvimCwd,
        agents: {},
      },
    );

    const text = await getResultText(invocation);
    expect(text).toContain(
      "Docker environment requires 'dockerfile' and 'workspacePath' fields",
    );
  });

  it("spawns docker_root thread with correct dockerSpawnConfig", async () => {
    const threadManager = createMockThreadManager();

    const invocation = SpawnSubagents.execute(
      makeRequest({
        agents: [
          {
            prompt: "do docker work",
            environment: "docker",
            directory: tempDir,
            dockerfile: "Dockerfile",
            workspacePath: "/workspace",
          },
        ],
      }),
      {
        threadManager,
        threadId: "parent-1" as ThreadId,
        maxConcurrentSubagents: 10,
        maxConcurrentFastSubagents: 10,
        requestRender: vi.fn(),
        cwd: "/test" as NvimCwd,
        agents: {},
      },
    );

    await vi.waitFor(() => {
      expect(threadManager.spawnThread).toHaveBeenCalled();
    });
    threadManager.simulateYield("thread-1" as ThreadId, {
      status: "ok",
      value: "done",
    });

    await invocation.promise;
    expect(threadManager.spawnThread).toHaveBeenCalledWith(
      expect.objectContaining({
        threadType: "docker_root",
        dockerSpawnConfig: expect.objectContaining({
          containerName: "magenta-test-abc123",
          imageName: "magenta-dev-test",
          workspacePath: "/workspace",
          hostDir: tempDir,
        }),
      }),
    );
  });

  it("docker_unsupervised environment sets supervised=true", async () => {
    const threadManager = createMockThreadManager();

    SpawnSubagents.execute(
      makeRequest({
        agents: [
          {
            prompt: "do docker work",
            environment: "docker_unsupervised",
            directory: tempDir,
            dockerfile: "Dockerfile",
            workspacePath: "/workspace",
          },
        ],
      }),
      {
        threadManager,
        threadId: "parent-1" as ThreadId,
        maxConcurrentSubagents: 10,
        maxConcurrentFastSubagents: 10,
        requestRender: vi.fn(),
        cwd: "/test" as NvimCwd,
        agents: {},
      },
    );

    await vi.waitFor(() => {
      expect(threadManager.spawnThread).toHaveBeenCalled();
    });

    expect(threadManager.spawnThread).toHaveBeenCalledWith(
      expect.objectContaining({
        dockerSpawnConfig: expect.objectContaining({ supervised: true }),
      }),
    );
  });

  it("returns spawn-error when provision() rejects", async () => {
    vi.mocked(provisionContainer).mockRejectedValue(
      new Error("Docker daemon not running"),
    );
    const threadManager = createMockThreadManager();

    const invocation = SpawnSubagents.execute(
      makeRequest({
        agents: [
          {
            prompt: "do docker work",
            environment: "docker",
            directory: tempDir,
            dockerfile: "Dockerfile",
            workspacePath: "/workspace",
          },
        ],
      }),
      {
        threadManager,
        threadId: "parent-1" as ThreadId,
        maxConcurrentSubagents: 10,
        maxConcurrentFastSubagents: 10,
        requestRender: vi.fn(),
        cwd: "/test" as NvimCwd,
        agents: {},
      },
    );

    const text = await getResultText(invocation);
    expect(text).toContain("Docker daemon not running");
    expect(text).toContain("Failed: 1");
  });

  it("converts contextFiles to a prompt note for docker subagents", async () => {
    const spawnThread = vi.fn(() => Promise.resolve("thread_1" as ThreadId));
    const threadManager = createMockThreadManager({ spawnThread });

    const invocation = SpawnSubagents.execute(
      makeRequest({
        sharedContextFiles: ["/shared/common.ts" as UnresolvedFilePath],
        agents: [
          {
            prompt: "do docker work",
            environment: "docker",
            directory: tempDir,
            dockerfile: "Dockerfile",
            workspacePath: "/workspace",
            contextFiles: ["/host/path/file.ts" as UnresolvedFilePath],
          },
        ],
      }),
      {
        threadManager,
        threadId: "parent-1" as ThreadId,
        maxConcurrentSubagents: 10,
        maxConcurrentFastSubagents: 10,
        requestRender: vi.fn(),
        cwd: "/test" as NvimCwd,
        agents: {},
      },
    );

    await vi.waitFor(() => {
      expect(spawnThread).toHaveBeenCalled();
    });
    threadManager.simulateYield("thread_1" as ThreadId, {
      status: "ok",
      value: "done",
    });

    await invocation.promise;

    // contextFiles should NOT be passed to spawnThread for docker entries
    expect(spawnThread).toHaveBeenCalledWith(
      expect.not.objectContaining({
        contextFiles: expect.anything(),
      }),
    );

    // The prompt should contain a note about the context files
    expect(spawnThread).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining("/shared/common.ts"),
      }),
    );
    expect(spawnThread).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining("/host/path/file.ts"),
      }),
    );
    expect(spawnThread).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining("do docker work"),
      }),
    );
  });

  it("defaults directory to cwd when not specified", async () => {
    const threadManager = createMockThreadManager();

    SpawnSubagents.execute(
      makeRequest({
        agents: [
          {
            prompt: "do docker work",
            environment: "docker",
            dockerfile: "Dockerfile",
            workspacePath: "/workspace",
          },
        ],
      }),
      {
        threadManager,
        threadId: "parent-1" as ThreadId,
        maxConcurrentSubagents: 10,
        maxConcurrentFastSubagents: 10,
        requestRender: vi.fn(),
        cwd: tempDir as NvimCwd,
        agents: {},
      },
    );

    await vi.waitFor(() => {
      expect(threadManager.spawnThread).toHaveBeenCalled();
    });

    expect(provisionContainer).toHaveBeenCalledWith(
      expect.objectContaining({ hostDir: tempDir }),
    );
  });

  it("mixed agents: docker and non-docker in parallel", async () => {
    let callCount = 0;
    const threadManager = createMockThreadManager({
      spawnThread: vi.fn(() => {
        callCount++;
        return Promise.resolve(`thread_${callCount}` as ThreadId);
      }),
    });

    const invocation = SpawnSubagents.execute(
      makeRequest({
        agents: [
          { prompt: "non-docker task", agentType: "fast-edit" },
          {
            prompt: "docker task",
            environment: "docker",
            directory: tempDir,
            dockerfile: "Dockerfile",
            workspacePath: "/workspace",
          },
        ],
      }),
      {
        threadManager,
        threadId: "parent-1" as ThreadId,
        maxConcurrentSubagents: 10,
        maxConcurrentFastSubagents: 10,
        requestRender: vi.fn(),
        cwd: "/test" as NvimCwd,
        agents: {},
      },
    );

    await vi.waitFor(() => {
      expect(threadManager.spawnThread).toHaveBeenCalledTimes(2);
    });
    threadManager.simulateYield("thread_1" as ThreadId, {
      status: "ok",
      value: "done",
    });
    threadManager.simulateYield("thread_2" as ThreadId, {
      status: "ok",
      value: "done",
    });

    const text = await getResultText(invocation);
    expect(text).toContain("Total: 2");
    expect(text).toContain("Successful: 2");
  });
});

describe("sharedPrompt and sharedContextFiles", () => {
  it("sharedPrompt is prepended to each agent's prompt", async () => {
    const spawnThread = vi.fn(() => Promise.resolve("thread_1" as ThreadId));
    const threadManager = createMockThreadManager({ spawnThread });

    const invocation = SpawnSubagents.execute(
      makeRequest({
        sharedPrompt: "You are a helpful assistant.",
        agents: [{ prompt: "Do task 1" }, { prompt: "Do task 2" }],
      }),
      {
        threadManager,
        threadId: "parent-1" as ThreadId,
        maxConcurrentSubagents: 10,
        maxConcurrentFastSubagents: 10,
        requestRender: vi.fn(),
        cwd: "/test" as NvimCwd,
        agents: {},
      },
    );

    await vi.waitFor(() => {
      expect(spawnThread).toHaveBeenCalledTimes(2);
    });

    expect(spawnThread).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "You are a helpful assistant.\n\nDo task 1",
      }),
    );
    expect(spawnThread).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "You are a helpful assistant.\n\nDo task 2",
      }),
    );

    threadManager.simulateYield("thread_1" as ThreadId, {
      status: "ok",
      value: "done",
    });
    await invocation.promise;
  });

  it("sharedPrompt used alone when per-agent prompt is missing", async () => {
    const spawnThread = vi.fn(() => Promise.resolve("thread_1" as ThreadId));
    const threadManager = createMockThreadManager({ spawnThread });

    const invocation = SpawnSubagents.execute(
      makeRequest({
        sharedPrompt: "Shared instructions",
        agents: [{ agentType: "explore" }],
      }),
      {
        threadManager,
        threadId: "parent-1" as ThreadId,
        maxConcurrentSubagents: 10,
        maxConcurrentFastSubagents: 10,
        requestRender: vi.fn(),
        cwd: "/test" as NvimCwd,
        agents: {},
      },
    );

    await vi.waitFor(() => {
      expect(spawnThread).toHaveBeenCalled();
    });

    expect(spawnThread).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "Shared instructions" }),
    );

    threadManager.simulateYield("thread_1" as ThreadId, {
      status: "ok",
      value: "done",
    });
    await invocation.promise;
  });

  it("sharedContextFiles merge with per-agent contextFiles", async () => {
    const spawnThread = vi.fn(() => Promise.resolve("thread_1" as ThreadId));
    const threadManager = createMockThreadManager({ spawnThread });

    const invocation = SpawnSubagents.execute(
      makeRequest({
        sharedContextFiles: [
          "/shared/a.ts" as UnresolvedFilePath,
          "/shared/b.ts" as UnresolvedFilePath,
        ],
        agents: [
          {
            prompt: "task",
            contextFiles: ["/local/c.ts" as UnresolvedFilePath],
          },
        ],
      }),
      {
        threadManager,
        threadId: "parent-1" as ThreadId,
        maxConcurrentSubagents: 10,
        maxConcurrentFastSubagents: 10,
        requestRender: vi.fn(),
        cwd: "/test" as NvimCwd,
        agents: {},
      },
    );

    await vi.waitFor(() => {
      expect(spawnThread).toHaveBeenCalled();
    });

    expect(spawnThread).toHaveBeenCalledWith(
      expect.objectContaining({
        contextFiles: ["/shared/a.ts", "/shared/b.ts", "/local/c.ts"],
      }),
    );

    threadManager.simulateYield("thread_1" as ThreadId, {
      status: "ok",
      value: "done",
    });
    await invocation.promise;
  });

  it("sharedContextFiles used alone when per-agent has none", async () => {
    const spawnThread = vi.fn(() => Promise.resolve("thread_1" as ThreadId));
    const threadManager = createMockThreadManager({ spawnThread });

    const invocation = SpawnSubagents.execute(
      makeRequest({
        sharedContextFiles: ["/shared/a.ts" as UnresolvedFilePath],
        agents: [{ prompt: "task" }],
      }),
      {
        threadManager,
        threadId: "parent-1" as ThreadId,
        maxConcurrentSubagents: 10,
        maxConcurrentFastSubagents: 10,
        requestRender: vi.fn(),
        cwd: "/test" as NvimCwd,
        agents: {},
      },
    );

    await vi.waitFor(() => {
      expect(spawnThread).toHaveBeenCalled();
    });

    expect(spawnThread).toHaveBeenCalledWith(
      expect.objectContaining({
        contextFiles: ["/shared/a.ts"],
      }),
    );

    threadManager.simulateYield("thread_1" as ThreadId, {
      status: "ok",
      value: "done",
    });
    await invocation.promise;
  });
});

describe("environment routing", () => {
  it("environment: 'host' (or omitted) goes through non-docker path", async () => {
    const threadManager = createMockThreadManager();

    SpawnSubagents.execute(
      makeRequest({
        agents: [{ prompt: "task", environment: "host" }],
      }),
      {
        threadManager,
        threadId: "parent-1" as ThreadId,
        maxConcurrentSubagents: 10,
        maxConcurrentFastSubagents: 10,
        requestRender: vi.fn(),
        cwd: "/test" as NvimCwd,
        agents: {},
      },
    );

    await vi.waitFor(() => {
      expect(threadManager.spawnThread).toHaveBeenCalled();
    });

    expect(threadManager.spawnThread).toHaveBeenCalledWith(
      expect.objectContaining({ threadType: "subagent" }),
    );
  });

  it("environment + agentType are orthogonal: explore in docker", async () => {
    const threadManager = createMockThreadManager();

    SpawnSubagents.execute(
      makeRequest({
        agents: [
          {
            prompt: "find something",
            agentType: "explore",
            environment: "docker",
            directory: "/some/dir",
            dockerfile: "Dockerfile",
            workspacePath: "/workspace",
          },
        ],
      }),
      {
        threadManager,
        threadId: "parent-1" as ThreadId,
        maxConcurrentSubagents: 10,
        maxConcurrentFastSubagents: 10,
        requestRender: vi.fn(),
        cwd: "/test" as NvimCwd,
        agents: {},
      },
    );

    await vi.waitFor(() => {
      expect(threadManager.spawnThread).toHaveBeenCalled();
    });

    expect(threadManager.spawnThread).toHaveBeenCalledWith(
      expect.objectContaining({
        threadType: "docker_root",
        dockerSpawnConfig: expect.objectContaining({
          containerName: "magenta-test-abc123",
        }),
      }),
    );
  });
});

describe("validation: new fields", () => {
  it("rejects non-string sharedPrompt", () => {
    const result = SpawnSubagents.validateInput({
      sharedPrompt: 123,
      agents: [{ prompt: "test" }],
    });
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error).toContain("sharedPrompt");
    }
  });

  it("rejects non-array sharedContextFiles", () => {
    const result = SpawnSubagents.validateInput({
      sharedContextFiles: "file.ts",
      agents: [{ prompt: "test" }],
    });
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error).toContain("sharedContextFiles");
    }
  });

  it("rejects non-string items in sharedContextFiles", () => {
    const result = SpawnSubagents.validateInput({
      sharedContextFiles: [123],
      agents: [{ prompt: "test" }],
    });
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error).toContain("sharedContextFiles");
    }
  });

  it("rejects invalid environment value", () => {
    const result = SpawnSubagents.validateInput({
      agents: [{ prompt: "test", environment: "invalid" }],
    });
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error).toContain("environment");
    }
  });

  it("rejects missing prompt when no sharedPrompt", () => {
    const result = SpawnSubagents.validateInput({
      agents: [{ agentType: "explore" }],
    });
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error).toContain("prompt");
    }
  });

  it("accepts missing per-agent prompt when sharedPrompt provided", () => {
    const result = SpawnSubagents.validateInput({
      sharedPrompt: "do stuff",
      agents: [{ agentType: "explore" }],
    });
    expect(result.status).toBe("ok");
  });

  it("accepts valid environment values", () => {
    for (const env of ["host", "docker", "docker_unsupervised"]) {
      const result = SpawnSubagents.validateInput({
        agents: [
          {
            prompt: "test",
            environment: env,
            ...(env !== "host"
              ? { dockerfile: "Dockerfile", workspacePath: "/workspace" }
              : {}),
          },
        ],
      });
      expect(result.status).toBe("ok");
    }
  });

  it("rejects docker environment without dockerfile", () => {
    const result = SpawnSubagents.validateInput({
      agents: [
        { prompt: "test", environment: "docker", workspacePath: "/workspace" },
      ],
    });
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error).toContain("dockerfile");
      expect(result.error).toContain("workspacePath");
    }
  });

  it("rejects docker_unsupervised environment without workspacePath", () => {
    const result = SpawnSubagents.validateInput({
      agents: [
        {
          prompt: "test",
          environment: "docker_unsupervised",
          dockerfile: "Dockerfile",
        },
      ],
    });
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error).toContain("dockerfile");
      expect(result.error).toContain("workspacePath");
    }
  });

  it("rejects non-string dockerfile", () => {
    const result = SpawnSubagents.validateInput({
      agents: [{ prompt: "test", dockerfile: 123 }],
    });
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error).toContain("dockerfile");
    }
  });

  it("rejects non-string workspacePath", () => {
    const result = SpawnSubagents.validateInput({
      agents: [{ prompt: "test", workspacePath: true }],
    });
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error).toContain("workspacePath");
    }
  });
});

describe("resolveSubagentConfig", () => {
  it("propagates effort from AgentInfo to SubagentConfig", () => {
    const agents = {
      think: {
        name: "think",
        description: "deep reasoning",
        systemPrompt: "think hard",
        systemReminder: undefined,
        fastModel: undefined,
        thinkingModel: undefined,
        effort: "max" as const,
        tier: "leaf" as const,
      },
    };
    const config = SpawnSubagents.resolveSubagentConfig(
      { agentType: "think" },
      agents,
    );
    expect(config.effort).toBe("max");
  });

  it("passes undefined effort through as undefined", () => {
    const agents = {
      explore: {
        name: "explore",
        description: "explore",
        systemPrompt: "",
        systemReminder: undefined,
        fastModel: true,
        thinkingModel: undefined,
        effort: undefined,
        tier: "leaf" as const,
      },
    };
    const config = SpawnSubagents.resolveSubagentConfig(
      { agentType: "explore" },
      agents,
    );
    expect(config.effort).toBeUndefined();
  });
});

describe("getSpec", () => {
  it("does not include fast, docker, docker_unsupervised in agentType enum", () => {
    const spec = SpawnSubagents.getSpec({});
    const schema = spec.input_schema as {
      properties: {
        agents: { items: { properties: { agentType: { enum: string[] } } } };
      };
    };
    const agentTypeEnum =
      schema.properties.agents.items.properties.agentType.enum;
    expect(agentTypeEnum).not.toContain("fast");
    expect(agentTypeEnum).not.toContain("docker");
    expect(agentTypeEnum).not.toContain("docker_unsupervised");
  });

  it("includes default and custom agent names in agentType enum", () => {
    const agents = {
      explore: {
        name: "explore",
        description: "explore",
        systemPrompt: "",
        systemReminder: undefined,
        fastModel: true,
        thinkingModel: undefined,
        effort: undefined,
        tier: "leaf" as const,
      },
      "my-agent": {
        name: "my-agent",
        description: "custom",
        systemPrompt: "",
        systemReminder: undefined,
        fastModel: undefined,
        thinkingModel: undefined,
        effort: undefined,
        tier: "leaf" as const,
      },
    };
    const spec = SpawnSubagents.getSpec(agents);
    const schema = spec.input_schema as {
      properties: {
        agents: { items: { properties: { agentType: { enum: string[] } } } };
      };
    };
    const agentTypeEnum =
      schema.properties.agents.items.properties.agentType.enum;
    expect(agentTypeEnum).toContain("explore");
    expect(agentTypeEnum).toContain("my-agent");
  });

  it("omits environment property when no dockerfile is configured", () => {
    const spec = SpawnSubagents.getSpec({});
    const schema = spec.input_schema as {
      properties: {
        agents: {
          items: { properties: Record<string, unknown> };
        };
      };
    };
    expect(schema.properties.agents.items.properties).not.toHaveProperty(
      "environment",
    );
  });
  it("includes environment property with correct enum when a dockerfile is configured", () => {
    const spec = SpawnSubagents.getSpec({}, undefined, "docker/Dockerfile");
    const schema = spec.input_schema as {
      properties: {
        agents: {
          items: { properties: { environment: { enum: string[] } } };
        };
      };
    };
    const envEnum = schema.properties.agents.items.properties.environment.enum;
    expect(envEnum).toEqual(["host", "docker", "docker_unsupervised"]);
    expect(spec.description).toContain("docker/Dockerfile");
  });

  it("includes top-level sharedPrompt and sharedContextFiles properties", () => {
    const spec = SpawnSubagents.getSpec({});
    const schema = spec.input_schema as {
      properties: Record<string, unknown>;
    };
    expect(schema.properties).toHaveProperty("sharedPrompt");
    expect(schema.properties).toHaveProperty("sharedContextFiles");
  });
});
