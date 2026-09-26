import { describe, expect, it, vi } from "vitest";
import { createTestAgent } from "./test-helpers.ts";
import { executeToolBatch } from "./tool-executor.ts";
import type {
  ExecutedToolResult,
  ToolName,
  ToolRequestId,
} from "./tool-types.ts";
import { Defer } from "./utils/async.ts";

describe("runToolLoop abort handle", () => {
  it("aborts an in-flight budget check without issuing a request", async () => {
    const entered = new Defer<void>();
    const abortCount = vi.fn();
    const counting = new Defer<{ type: "aborted" }>();
    const { agent, mockClient } = createTestAgent({
      checkBudget: () => {
        entered.resolve();
        return {
          promise: counting.promise,
          abort: () => {
            abortCount();
            counting.resolve({ type: "aborted" });
          },
        };
      },
    });
    const turn = agent.send([{ type: "text", text: "go" }]);
    await entered.promise;
    turn.abort();
    expect(await turn.promise).toEqual({ type: "aborted" });
    expect(abortCount).toHaveBeenCalledTimes(1);
    expect(mockClient.streams).toHaveLength(0);
  });

  it("aborts every live tool invocation and writes their results", async () => {
    const created = new Defer<void>();
    const aborted: string[] = [];
    const { agent, mockClient } = createTestAgent({
      executeTools: (requests, publishTools) =>
        executeToolBatch(requests, {
          completedTools: new Map(),
          publishTools,
          onUpdate: () => {},
          createTool: (request) => {
            const result = new Defer<ExecutedToolResult>();
            if (request.id === "tool-2") created.resolve();
            return {
              promise: result.promise,
              abort: () => {
                aborted.push(request.id);
                result.resolve({
                  type: "tool_result",
                  id: request.id,
                  result: { status: "error", error: "aborted by test" },
                });
              },
            };
          },
        }),
    });
    const turn = agent.send([{ type: "text", text: "go" }]);
    const stream = await mockClient.awaitStream();
    for (const id of ["tool-1", "tool-2"]) {
      stream.streamToolUse(id as ToolRequestId, "get_files" as ToolName, {
        files: [{ filePath: "/tmp/a.txt" }],
      });
    }
    stream.finishResponse("tool_use");
    await created.promise;
    turn.abort();
    expect(await turn.promise).toEqual({ type: "aborted" });
    expect(aborted.sort()).toEqual(["tool-1", "tool-2"]);
    const serialized = JSON.stringify(agent.getProviderMessages());
    expect(serialized).toContain("aborted by test");
    expect(mockClient.streams).toHaveLength(1);
  });

  it("treats abort after the loop settled as a no-op", async () => {
    const { agent, mockClient } = createTestAgent();
    const turn = agent.send([{ type: "text", text: "hi" }]);
    const stream = await mockClient.awaitStream();
    stream.finishResponse("end_turn");
    const result = await turn.promise;
    expect(result).toEqual({ type: "completed", stopReason: "end_turn" });
    const messages = structuredClone(agent.getProviderMessages());
    turn.abort();
    turn.abort();
    expect(turn.aborting).toBe(false);
    expect(agent.getProviderMessages()).toEqual(messages);
  });
});
