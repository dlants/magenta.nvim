import type { ProviderToolResult } from "../providers/provider-types";
import type { VDOMNode } from "../tea/view";
import type { StaticToolName } from "./tool-registry";
import type { StaticToolRequest } from "./toolManager";

export type ToolRequestId = string & { __toolRequestId: true };

/** Opaque toolName type. Internally we'll differentiate between static tools and mcp tools, but external to the tool
 * manager, we'll use opaque types.
 */
export type ToolName = string & { __toolName: true };

export type ToolRequest = {
  id: ToolRequestId;
  toolName: ToolName;
  input: unknown;
};

export interface Tool {
  toolName: ToolName;
  isDone(): boolean;
  getToolResult(): ProviderToolResult;
  request: ToolRequest;
  abort(): void;
  renderSummary(): VDOMNode;
  renderPreview?(): VDOMNode;
  displayInput(): string | VDOMNode;
}

export interface StaticTool {
  toolName: StaticToolName;
  isDone(): boolean;
  getToolResult(): ProviderToolResult;
  request: StaticToolRequest;
  abort(): void;
  renderSummary(): VDOMNode;
  renderPreview?(): VDOMNode;
  displayInput(): string | VDOMNode;
}

export type ToolManagerToolMsg = {
  type: "tool-msg";
  msg: {
    id: ToolRequestId;
    toolName: ToolName;
    msg: ToolMsg;
  };
};
/** Opaque tool message for external consumption
 */
export type ToolMsg = { __toolMsg: true };
