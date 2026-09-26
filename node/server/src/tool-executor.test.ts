import { describe, expect, it, vi } from "vitest";
import type { NonEmptyRequestedTools } from "./providers/provider-types.ts";
import { executeToolBatch } from "./tool-executor.ts";
import type {
  CompletedToolInfo,
  ExecutedToolResult,
  ToolInvocation,
  ToolName,
  ToolRequest,
  ToolRequestId,
} from "./tool-types.ts";

describe("executeToolBatch", () => {
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
      result:
        mode === "error"
          ? { status: "error", error: "failed" }
          : {
              status: "ok",
              value: [],
              ...(structuredResult ? { structuredResult } : {}),
            },
    };
    const deps = {
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
      publishTools: () => {},
      onUpdate: () => {},
    };
    const outcome = await executeToolBatch(
      [{ id: request.id, request: { status: "ok", value: request } }],
      deps,
    ).promise;
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

  it("aborts the batch through its execution handle", async () => {
    let settle!: () => void;
    const abort = vi.fn(() => settle());
    const invocation: ToolInvocation = {
      promise: new Promise((resolve) => {
        settle = () =>
          resolve({
            type: "tool_result",
            id: "tool-1" as ToolRequestId,
            result: { status: "error", error: "aborted" },
          });
      }),
      abort,
    };
    const completedTools = new Map<ToolRequestId, CompletedToolInfo>();
    const deps = {
      completedTools,
      createTool: () => invocation,
      publishTools: () => {},
      onUpdate: () => {},
    };
    const request: ToolRequest = {
      id: "tool-1" as ToolRequestId,
      toolName: "get_files" as ToolName,
      input: { files: [{ filePath: "/tmp/a.txt" }] },
    } as ToolRequest;
    const requests: NonEmptyRequestedTools = [
      { id: request.id, request: { status: "ok", value: request } },
    ];

    const execution = executeToolBatch(requests, deps);
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
  it("aborts invocations created after an abort lands mid-batch", async () => {
    const aborts: string[] = [];
    let execution!: ReturnType<typeof executeToolBatch>;
    const requestFor = (id: string): ToolRequest =>
      ({
        id: id as ToolRequestId,
        toolName: "get_files" as ToolName,
        input: { files: [{ filePath: "/tmp/a.txt" }] },
      }) as ToolRequest;
    const deps = {
      completedTools: new Map<ToolRequestId, CompletedToolInfo>(),
      createTool: (request: ToolRequest): ToolInvocation => {
        let settle!: () => void;
        const promise = new Promise<ExecutedToolResult>((resolve) => {
          settle = () =>
            resolve({
              type: "tool_result",
              id: request.id,
              result: { status: "error", error: "aborted" },
            });
        });
        // The first creation aborts the batch before the second is created.
        if (request.id === "tool-1") execution.abort();
        return {
          promise,
          abort: () => {
            aborts.push(request.id);
            settle();
          },
        };
      },
      publishTools: () => {},
      onUpdate: () => {},
    };
    const requests: NonEmptyRequestedTools = [
      {
        id: "tool-1" as ToolRequestId,
        request: { status: "ok", value: requestFor("tool-1") },
      },
      {
        id: "tool-2" as ToolRequestId,
        request: { status: "ok", value: requestFor("tool-2") },
      },
    ];
    execution = executeToolBatch(requests, deps);
    const outcome = await execution.promise;
    expect(outcome.type).toBe("aborted");
    expect(aborts.sort()).toEqual(["tool-1", "tool-2"]);
    execution.abort();
    expect(aborts).toHaveLength(2);
  });
});
