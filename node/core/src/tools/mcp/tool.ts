import { PLACEHOLDER_NATIVE_MESSAGE_IDX, type ProviderToolResult } from "../../providers/provider-types.ts";
import type {
  ToolInvocation,
  ToolName,
  ToolRequestId,
} from "../../tool-types.ts";
import type { MCPClient } from "./client.ts";
import { type MCPToolRequestParams, parseToolName } from "./types.ts";

export type Input = {
  [key: string]: unknown;
};

export type MCPProgress = {
  startTime: number;
};

export function execute(
  request: {
    id: ToolRequestId;
    toolName: ToolName;
    input: Input;
  },
  context: {
    mcpClient: MCPClient;
    requestRender: () => void;
  },
): ToolInvocation & { progress: MCPProgress } {
  let aborted = false;

  const progress: MCPProgress = {
    startTime: Date.now(),
  };

  const tickInterval = setInterval(() => {
    context.requestRender();
  }, 1000);

  const abortResult: ProviderToolResult = {
    type: "tool_result",
    id: request.id,
    result: { status: "error", error: "Request was aborted by the user." },
    nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
  };

  const promise = (async (): Promise<ProviderToolResult> => {
    try {
      if (aborted) return abortResult;

      const mcpToolName = parseToolName(request.toolName).mcpToolName;
      const params = request.input as MCPToolRequestParams;

      const result = await context.mcpClient.callTool(mcpToolName, params);

      if (aborted) return abortResult;

      return {
        type: "tool_result",
        id: request.id,
        result: {
          status: "ok",
          value: result,
          structuredResult: { toolName: request.toolName },
        },
        nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
      };
    } catch (error) {
      if (aborted) return abortResult;

      const errorMessage =
        error instanceof Error
          ? `${error.message}\n${error.stack}`
          : String(error);

      return {
        type: "tool_result",
        id: request.id,
        result: {
          status: "error",
          error: `MCP tool error: ${errorMessage}`,
        },
        nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
      };
    } finally {
      clearInterval(tickInterval);
    }
  })();

  return {
    promise,
    progress,
    abort: () => {
      aborted = true;
      clearInterval(tickInterval);
    },
  };
}
