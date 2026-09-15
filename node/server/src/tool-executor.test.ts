import { describe, expect, it, vi } from "vitest";
import type {
  NativeMessageIdx,
  NonEmptyRequestedTools,
} from "./providers/provider-types.ts";
import { ToolExecutorHost } from "./tool-executor.ts";
import type {
  CompletedToolInfo,
  ExecutedToolResult,
  ToolInvocation,
  ToolName,
  ToolRequest,
  ToolRequestId,
} from "./tool-types.ts";

describe("ToolExecutorHost", () => {
  it.each([
    "structured",
    "plain",
    "error",
    "throw",
    "reject",
  ] as const)("archives the request and provider result for %s executions", async (mode) => {
    const completedTools = new Map<ToolRequestId, CompletedToolInfo>();
    const request: ToolRequest = {
      id: "tool-1" as ToolRequestId,
      toolName: "thread_title" as ToolName,
      input: { title: "A title" },
    };
    const structuredResult =
      mode === "structured" ? { toolName: "thread_title" as const } : undefined;
    const executed: ExecutedToolResult = {
      type: "tool_result",
      id: request.id,
      nativeMessageIdx: 0 as NativeMessageIdx,
      result:
        mode === "error"
          ? { status: "error", error: "failed" }
          : {
              status: "ok",
              value: [],
              ...(structuredResult ? { structuredResult } : {}),
            },
    };
    const host = new ToolExecutorHost({
      completedTools,
      createTool: () => {
        if (mode === "throw") throw new Error("creation failed");
        return {
          promise:
            mode === "reject"
              ? Promise.reject(new Error("execution failed"))
              : Promise.resolve(executed),
          abort: () => {},
        };
      },
      getPendingResultMessageIdx: () => 0 as NativeMessageIdx,
      publishTools: () => {},
      onUpdate: () => {},
    });
    const outcome = await host.execute([
      { id: request.id, request: { status: "ok", value: request } },
    ]).promise;
    const completed = completedTools.get(request.id);
    expect(completed).toBeDefined();
    expect(completed?.request).toBe(request);
    expect(completed?.structuredResult).toBe(structuredResult);
    expect(completed?.result).toMatchObject({
      type: "tool_result",
      id: request.id,
      result: outcome.results.get(request.id),
    });
    expect(completed?.result.result).not.toHaveProperty("structuredResult");
    expect(outcome.results.get(request.id)?.status).toBe(
      mode === "structured" || mode === "plain" ? "ok" : "error",
    );
  });

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
    const completedTools = new Map<ToolRequestId, CompletedToolInfo>();
    const host = new ToolExecutorHost({
      completedTools,
      createTool: () => invocation,
      getPendingResultMessageIdx: () => 0 as NativeMessageIdx,
      publishTools: () => {},
      onUpdate: () => {},
    });
    const request: ToolRequest = {
      id: "tool-1" as ToolRequestId,
      toolName: "get_files" as ToolName,
      input: { files: [{ filePath: "/tmp/a.txt" }] },
    } as ToolRequest;
    const requests: NonEmptyRequestedTools = [
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
    expect(completedTools.get(request.id)).toMatchObject({
      request,
      result: { result: { status: "error", error: "aborted" } },
      structuredResult: undefined,
    });
  });
});
