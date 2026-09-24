import type {
  NonEmptyRequestedTools,
  ToolResultInput,
  ToolResultValue,
} from "./providers/provider-types.ts";
import type { ToolInvocationState } from "./thread-api.ts";
import type { ToolOutcome } from "./tool-loop.ts";
import type {
  ActiveToolEntry,
  CompletedToolInfo,
  ExecutedToolResult,
  ExecutingToolInvocation,
  ToolInvocation,
  ToolRequest,
  ToolRequestId,
} from "./tool-types.ts";

export type ToolExecutorDeps = {
  createTool: (request: ToolRequest) => ExecutingToolInvocation;
  completedTools: Map<ToolRequestId, CompletedToolInfo>;
  /** Where the invocations are, for whoever renders them. */
  publishTools: (tools: ToolInvocationState) => void;
  onUpdate: () => void;
  signal: AbortSignal;
};

export function executeToolBatch(
  requests: NonEmptyRequestedTools,
  deps: ToolExecutorDeps,
): Promise<ToolOutcome> {
  const { signal } = deps;
  let live = new Map<ToolRequestId, ActiveToolEntry>();
  const abort = () => {
    for (const entry of live.values()) entry.handle.abort();
  };

  function recordCompletedTool(
    request: ToolRequest,
    executed: ExecutedToolResult,
  ): ToolResultInput {
    const structuredResult =
      executed.result.status === "ok"
        ? executed.result.structuredResult
        : undefined;
    const result: ToolResultInput = {
      ...executed,
      result:
        executed.result.status === "ok"
          ? { status: "ok", value: executed.result.value }
          : executed.result,
    };
    deps.completedTools.set(request.id, {
      request,
      result,
      structuredResult,
    });
    return result;
  }

  async function runBatch(): Promise<ToolOutcome> {
    const activeTools = new Map<ToolRequestId, ActiveToolEntry>();
    const results = new Map<ToolRequestId, ToolResultValue>();

    for (const requested of requests) {
      if (requested.request.status !== "ok") {
        results.set(requested.id, {
          status: "error",
          error: `Malformed tool_use block: ${requested.request.error}`,
        });
        continue;
      }
      const request = requested.request.value;
      let invocation: ToolInvocation;
      try {
        invocation = deps.createTool(request);
      } catch (err) {
        const result = recordCompletedTool(request, {
          type: "tool_result",
          id: requested.id,
          result: {
            status: "error",
            error: `Tool creation failed: ${(err as Error).message}`,
          },
        });
        results.set(requested.id, result.result);
        continue;
      }
      activeTools.set(request.id, {
        handle: invocation,
        progress: "progress" in invocation ? invocation.progress : undefined,
        toolName: request.toolName,
        request,
      });
    }

    live = activeTools;
    if (signal.aborted) abort();
    deps.publishTools({ type: "running", activeTools });

    const settled = await Promise.all(
      [...activeTools].map(async ([id, entry]) => {
        let result: ExecutedToolResult;
        try {
          result = await entry.handle.promise;
        } catch (err) {
          result = {
            type: "tool_result",
            id,
            result: {
              status: "error",
              error: `Tool execution failed: ${(err as Error).message}`,
            },
          };
        }
        const wireResult = recordCompletedTool(entry.request, result);
        entry.result = wireResult;
        deps.onUpdate();
        return [id, wireResult] as const;
      }),
    );

    for (const [id, result] of settled) {
      results.set(id, result.result);
    }

    // Nothing is running any more: `activeTools` means *live* invocations, and
    // the view switches from tool progress to results the moment it empties.
    live = new Map();
    deps.publishTools({ type: "settled" });

    return { type: signal.aborted ? "aborted" : "continue", results };
  }

  signal.addEventListener("abort", abort, { once: true });
  return runBatch().finally(() => signal.removeEventListener("abort", abort));
}
