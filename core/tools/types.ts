import type { ProviderToolResult } from "../agent/provider-types.ts";
import type { Logger } from "../logger.ts";
import type { Dispatch } from "../tea/tea.ts";
import type { Cwd, HomeDir } from "../utils/files.ts";

export type DisplayContext = {
  cwd?: Cwd;
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

export type GenericToolRequest<K extends string, I> = {
  id: ToolRequestId;
  toolName: K;
  input: I;
};

export type ToolRequest = {
  id: ToolRequestId;
  toolName: ToolName;
  input: unknown;
};

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
export interface Tool {
  toolName: ToolName;
  aborted: boolean;
  request: ToolRequest;
  isDone(): boolean;
  isPendingUserAction(): boolean;
  getToolResult(): ProviderToolResult;
  abort(): ProviderToolResult;
  update(msg: ToolMsg): void;
}

export interface StaticTool extends Tool {
  request: GenericToolRequest<ToolName, unknown>;
}

export type ToolContext = {
  logger: Logger;
  cwd: Cwd;
  homeDir: HomeDir;
  myDispatch: Dispatch<ToolMsg>;
};
