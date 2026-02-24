import type { ProviderToolResult } from "../providers/provider-types.ts";
import type { VDOMNode } from "../tea/view.ts";
import type { StaticToolName } from "./tool-registry.ts";
import type { NvimCwd, HomeDir } from "../utils/files.ts";

export type DisplayContext = {
  cwd: NvimCwd;
  homeDir: HomeDir;
};

export type CompletedToolInfo = {
  request: ToolRequest;
  result: ProviderToolResult;
};

export type ToolRequestId = string & { __toolRequestId: true };

/** Opaque toolName type. Internally we'll differentiate between static tools and mcp tools, but external to the tool
 * manager, we'll use opaque types.
 */
export type ToolName = string & { __toolName: true };

export type GenericToolRequest<K extends StaticToolName, I> = {
  id: ToolRequestId;
  toolName: K;
  input: I;
};

export type ToolRequest = {
  id: ToolRequestId;
  toolName: ToolName;
  input: unknown;
};

export interface Tool {
  toolName: ToolName;
  aborted: boolean;
  isDone(): boolean;
  isPendingUserAction(): boolean;
  getToolResult(): ProviderToolResult;
  request: ToolRequest;
  /** Abort the tool and return its result synchronously */
  abort(): ProviderToolResult;
  renderSummary(): VDOMNode;
  renderPreview?(): VDOMNode;
  renderDetail?(): VDOMNode;
}

export interface StaticTool {
  toolName: StaticToolName;
  aborted: boolean;
  isDone(): boolean;
  isPendingUserAction(): boolean;
  getToolResult(): ProviderToolResult;
  request: GenericToolRequest<StaticToolName, unknown>;
  /** Abort the tool and return its result synchronously */
  abort(): ProviderToolResult;
  renderSummary(): VDOMNode;
  renderPreview?(): VDOMNode;
  renderDetail?(): VDOMNode;
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

// ===== New ToolInvocation types =====

export type ToolInvocation = {
  promise: Promise<ProviderToolResult>;
  abort: () => void;
};
