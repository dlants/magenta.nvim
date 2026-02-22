import type { ProviderToolResult } from "../../providers/provider.ts";
import { d, withInlineCode, type VDOMNode } from "../../tea/view.ts";
import type {
  ToolInvocation,
  ToolRequest as UnionToolRequest,
  ToolRequestId,
  ToolName,
  DisplayContext,
  CompletedToolInfo,
} from "../types.ts";
import type { MCPClient } from "./client.ts";
import { parseToolName, type MCPToolRequestParams } from "./types.ts";

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
        },
      };
    } catch (error) {
      if (aborted) return abortResult;

      const errorMessage =
        error instanceof Error
          ? error.message + "\n" + error.stack
          : String(error);

      return {
        type: "tool_result",
        id: request.id,
        result: {
          status: "error",
          error: `MCP tool error: ${errorMessage}`,
        },
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

export function renderInFlightSummary(
  request: UnionToolRequest,
  _displayContext: DisplayContext,
  progress?: MCPProgress,
): VDOMNode {
  if (progress) {
    const runningTime = Math.floor((Date.now() - progress.startTime) / 1000);
    return d`🔨⚙️ (${String(runningTime)}s) MCP tool ${withInlineCode(d`\`${request.toolName}\``)}`;
  }
  return d`🔨⚙️ MCP tool ${withInlineCode(d`\`${request.toolName}\``)} processing...`;
}

function getStatusEmoji(result: ProviderToolResult): string {
  return result.result.status === "error" ? "❌" : "✅";
}

export function renderCompletedSummary(
  info: CompletedToolInfo,
  _displayContext: DisplayContext,
): VDOMNode {
  return d`🔨${getStatusEmoji(info.result)} MCP tool ${withInlineCode(d`\`${info.request.toolName}\``)}`;
}
