import { describe, expect, it, vi } from "vitest";
import type { RequestedTool } from "./providers/provider-types.ts";
import { agentHooks, noopLogger } from "./test-helpers.ts";
import { ToolExecutorHost } from "./tool-executor.ts";
import type {
  ToolInvocation,
  ToolName,
  ToolRequest,
  ToolRequestId,
} from "./tool-types.ts";

describe("ToolExecutorHost", () => {
  it("aborts an invocation created while the owner was already aborting", async () => {
    // The window this pins: the abort lands after the invocations exist but
    // before they are published, so nothing else can reach them.
    let settle!: () => void;
    const abort = vi.fn(() => settle());
    const invocation: ToolInvocation = {
      promise: new Promise((resolve) => {
        settle = () =>
          resolve({
            type: "tool_result",
            id: "tool-1" as ToolRequestId,
            result: { status: "error", error: "aborted" },
            nativeMessageIdx: 0 as never,
          });
      }),
      abort,
    };
    const host = new ToolExecutorHost({
      logger: noopLogger,
      createTool: () => invocation,
      getHooks: () => agentHooks(),
      publishTools: () => {},
      onUpdate: () => {},
    });
    const request: ToolRequest = {
      id: "tool-1" as ToolRequestId,
      toolName: "get_files" as ToolName,
      input: { files: [{ filePath: "/tmp/a.txt" }] },
    } as ToolRequest;
    const requests: RequestedTool[] = [
      { id: request.id, request: { status: "ok", value: request } },
    ];

    const execution = host.execute(requests);
    execution.abort();
    const outcome = await execution.promise;
    expect(abort).toHaveBeenCalled();
    expect(outcome.type).toBe("aborted");
    expect(outcome.results.get(request.id)).toEqual({
      status: "error",
      error: "aborted",
    });
  });
});
