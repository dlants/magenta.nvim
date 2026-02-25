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
import type { NvimCwd, HomeDir } from "./utils/files.ts";
import type { ProviderToolResult } from "./providers/provider-types.ts";
import type { StaticToolName } from "./tools/tool-registry.ts";
import type { Result } from "./utils/result.ts";

export type DisplayContext = {
  cwd: NvimCwd;
  homeDir: HomeDir;
};

export type CompletedToolInfo = {
  request: ToolRequest;
  result: ProviderToolResult;
};

export type GenericToolRequest<K extends StaticToolName, I> = {
  id: ToolRequestId;
  toolName: K;
  input: I;
};

export type ToolManagerToolMsg = {
  type: "tool-msg";
  msg: {
    id: ToolRequestId;
    toolName: ToolName;
    msg: ToolMsg;
  };
};

export type ToolMsg = { __toolMsg: true };

export type ToolInvocation = {
  promise: Promise<ProviderToolResult>;
  abort: () => void;
};
export type ValidateInput = (
  toolName: unknown,
  input: { [key: string]: unknown },
) => Result<Record<string, unknown>>;
