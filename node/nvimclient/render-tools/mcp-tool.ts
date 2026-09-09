import type {
  CompletedToolInfo,
  DisplayContext,
  MCPProgress,
  ToolRequest as UnionToolRequest,
} from "@magenta/server";
import { d, type VDOMNode, withInlineCode } from "../tea/view.ts";
export type { MCPProgress };

export function renderSummary(
  request: UnionToolRequest,
  _displayContext: DisplayContext,
): VDOMNode {
  return d`🔨 MCP tool ${withInlineCode(d`\`${request.toolName}\``)}`;
}

export function renderProgress(
  _request: UnionToolRequest,
  progress: MCPProgress,
  _displayContext: DisplayContext,
  _expanded: boolean,
): VDOMNode | undefined {
  const runningTime = Math.floor((Date.now() - progress.startTime) / 1000);
  return d`(${String(runningTime)}s) processing...`;
}

export function renderResultSummary(
  info: CompletedToolInfo,
  _displayContext: DisplayContext,
): VDOMNode {
  const suffix = info.result.result.status === "error" ? " error" : "";
  return d`MCP tool ${withInlineCode(d`\`${info.request.toolName}\``)}${suffix}`;
}
